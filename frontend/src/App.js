import { getBackendUrl } from './utils/backendUrl';
import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Routes, Route, useNavigate, useLocation, Link } from 'react-router-dom';
import { Moon, Sun, LogOut, Upload as UploadIcon, HardDrive, History, LogIn, FileText, Menu, X, MessageCircle, Pencil, Share2, Zap } from 'lucide-react';
import { useTheme } from './contexts/ThemeContext';
import { useAuth } from './contexts/AuthContext';
import { setAuthToken, getAuthToken } from './utils/authStorage';
import GuestModal from './components/GuestModal';
import AuthModal from './components/AuthModal';
import LoginPage from './components/LoginPage';
import UploadZone from './components/UploadZone';
import FileCard from './components/FileCard';
import FolderCard from './components/FolderCard';
import FilePreviewModal from './components/FilePreviewModal';
import ProgressIndicator from './components/ProgressIndicator';
import ShareModal2 from './components/ShareModal2';
import GoogleDrivePicker from './components/GoogleDrivePicker';
import WelcomeScreen from './components/WelcomeScreen';
import GoogleDriveConnectModal from './components/GoogleDriveConnectModal';
import GoogleDriveView from './components/GoogleDriveView';
import HistoryView from './components/HistoryView';
import UploadOptionsModal from './components/UploadOptionsModal'; // Changed from UploadModal
import ReceiveFileView from './components/ReceiveFileView';
import AdminView from './components/AdminView';
import ConfirmModal from './components/ConfirmModal';
import ChatView from './components/ChatView';
import AvatarPickerModal from './components/AvatarPickerModal';
import ProfileModal from './components/ProfileModal';
import AmbientBackground from './components/AmbientBackground';
import P2PReceivedPreviewModal from './components/P2PReceivedPreviewModal';
import LoadingScreen from './components/LoadingScreen';
import webrtcManager from './utils/webrtcManager2';
import { isOfflineMode } from './utils/offline';
import './App.css';

const BACKEND_URL = getBackendUrl();
const API = `${BACKEND_URL}/api`;

// Guest data limit (2GB in bytes)
const GUEST_DATA_LIMIT = 2 * 1024 * 1024 * 1024;
const CLOUD_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100MB cap for cloud uploads
const CLOUD_UPLOAD_MAX_LABEL = '100 MB';

function App() {
  const { theme, toggleTheme } = useTheme();
  const { user, token, loading: authLoading, loginAsGuest, register, login, logout, setToken, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [files, setFiles] = useState([]);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showLoginPage, setShowLoginPage] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [dataLimitReached, setDataLimitReached] = useState(false);
  const [driveConfigured, setDriveConfigured] = useState(true);
  const [showWelcome, setShowWelcome] = useState(false);
  const [guestLoginError, setGuestLoginError] = useState('');
  const [showLoading, setShowLoading] = useState(true);
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeExiting, setWelcomeExiting] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);
  const hadUserRef = useRef(false);
  const [showDriveConnectModal, setShowDriveConnectModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [receivedFile, setReceivedFile] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (message, kind = 'success') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    const onToast = (e) => {
      const { message, kind } = (e && e.detail) || {};
      if (message) showToast(message, kind || 'info');
    };
    window.addEventListener('app-toast', onToast);
    return () => window.removeEventListener('app-toast', onToast);
  }, []);

  // Show welcome on every load when no user is signed in.
  // User explicitly clicks "Enter UniShare" to dismiss it for this session.
  // Skip welcome if the user just logged out (hadUserRef tracks this).
  useEffect(() => {
    if (user) {
      hadUserRef.current = true;
    }
    if (!authLoading && !user && !hadUserRef.current && !location.pathname.startsWith('/receive')) {
      setShowWelcome(true);
    }
  }, [authLoading, user, location]);

  // Trigger welcome entrance animation once it mounts after loading screen exits
  useEffect(() => {
    if (showWelcome && !welcomeVisible) {
      requestAnimationFrame(() => setWelcomeVisible(true));
    }
  }, [showWelcome, welcomeVisible]);

  // Wipe guest data on tab close / page hide via sendBeacon.
  // Beacons cannot set Authorization headers, so the token goes in the URL.
  useEffect(() => {
    if (!user || !user.is_guest || !token || token.startsWith('local-')) {
      return undefined;
    }
    const beaconUrl = `${API}/auth/logout-beacon?token=${encodeURIComponent(token)}`;
    const fire = () => {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(beaconUrl, new Blob([], { type: 'text/plain' }));
        } else {
          fetch(beaconUrl, { method: 'POST', keepalive: true }).catch(() => {});
        }
      } catch {
        /* swallow */
      }
    };
    window.addEventListener('pagehide', fire);
    window.addEventListener('beforeunload', fire);
    return () => {
      window.removeEventListener('pagehide', fire);
      window.removeEventListener('beforeunload', fire);
    };
  }, [user, token]);

  // Handle Google OAuth callback and Google Drive connection callback
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const googleAuth = urlParams.get('google_auth');
    const tokenParam = urlParams.get('token');
    const googleDrivePrompt = urlParams.get('google_drive_prompt');
    const driveConnected = urlParams.get('drive_connected');
    const driveError = urlParams.get('drive_error');

    if (googleAuth === 'success' && tokenParam) {
      setAuthToken(tokenParam);
      setToken(tokenParam);

      axios.get(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${tokenParam}` }
      }).then(response => {
        setUser(response.data);
        setShowLoginPage(false);
        if (googleDrivePrompt === 'true' && !response.data.google_drive_connected) {
          setShowDriveConnectModal(true);
        }
      }).catch(error => {
        console.error('Failed to fetch user info:', error);
        setShowLoginPage(false);
      });

      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (googleAuth === 'error') {
      alert('Google authentication failed. Please try again.');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (driveConnected === 'true') {
      if (token) {
        axios.get(`${API}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        }).then(response => {
          setUser(response.data);
          showToast('Google Drive connected successfully', 'success');
        }).catch(error => {
          console.error('Failed to refresh user info:', error);
        });
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (driveError === 'true') {
      showToast('Failed to connect Google Drive. Please try again.', 'error');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [setToken, setUser, token]);

  // Check auth and ask for guest username when needed
  // Skip if welcome is exiting to avoid interfering with the manual transition
  useEffect(() => {
    if (!authLoading && !user && showWelcome && !welcomeExiting) {
      setShowLoginPage(false);
      return;
    }
    if (!authLoading && !user && !showWelcome && !welcomeExiting && hadUserRef.current && !location.pathname.startsWith('/receive')) {
      setShowLoginPage(true);
    }
  }, [authLoading, user, showWelcome, welcomeExiting, location]);

  // Fetch files + connect signaling when user id is available.
  // Depend only on user.id to avoid reconnect churn when non-critical
  // user fields (e.g. muted_until) change.
  useEffect(() => {
    if (user?.id) {
      fetchFiles();
      webrtcManager.connect(user.id, BACKEND_URL, user.username, user.emoji);
      if (isOfflineMode()) {
        console.info('Offline mode enabled. P2P will use LAN signaling only.');
      }

      webrtcManager.onFileReceived = (filename, blob, peerId, metadata = {}) => {
        if (metadata.savedToDisk) {
          // Large file streamed straight to user's chosen save location — no Blob, no preview.
          window.dispatchEvent(new CustomEvent('app-toast', {
            detail: {
              message: `Received "${filename}" — saved to disk`,
              kind: 'success'
            }
          }));
          setDownloadProgress(null);
          return;
        }
        setReceivedFile({
          fileName: filename,
          blob,
          peerId,
          sender: metadata.sender,
          mimeType: metadata.mimeType || (blob && blob.type) || ''
        });
        setDownloadProgress(null);
      };

      webrtcManager.onProgressUpdate = (update) => {
        if (!update) return;
        if (update.type === 'receiving') {
          setDownloadProgress({
            progress: update.progress || 0,
            speed: update.speed || 0,
            timeRemaining: update.timeRemaining || 0,
            fileName: update.fileName || 'Incoming file'
          });
        } else if (update.type === 'declined') {
          setDownloadProgress(null);
        }
      };

      webrtcManager.onFileUploaded = () => {
        fetchFiles();
      };
    }

    return () => {
      if (user?.id) {
        webrtcManager.disconnect();
      }
    };
  }, [user?.id]);

  // Keep signaling profile in sync without forcing reconnects.
  useEffect(() => {
    if (!user?.id) return;
    webrtcManager.updateUserInfo(user.username, user.emoji);
  }, [user?.id, user?.username, user?.emoji]);

  useEffect(() => {
    if (!user || !token) return;
    const handler = (event) => {
      if (event.type === 'auto_unmuted') {
        axios.get(`${API}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        }).then(response => {
          setUser(response.data);
        }).catch(console.error);
      }
    };
    const prior = webrtcManager.onChatEvent;
    webrtcManager.onChatEvent = handler;
    return () => {
      webrtcManager.onChatEvent = prior;
    };
  }, [user, token, setUser]);

  const fetchFiles = async () => {
    if (!user || !token) return;
    try {
      const response = await axios.get(`${API}/files`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setFiles(response.data);
    } catch (error) {
      console.error('Failed to fetch files:', error);
    }
  };

  const handleGuestLogin = async (username, emoji) => {
    setGuestLoginError('');
    const result = await loginAsGuest(username, emoji);
    if (result.success) {
      setShowGuestModal(false);
      setGuestLoginError('');
    } else {
      setGuestLoginError(result.error);
    }
  };

  const handleAuth = async (emailOrUsername, passwordOrEmail, passwordOrMode, mode) => {
    let result;
    if (mode === 'register') {
      result = await register(emailOrUsername, passwordOrEmail, passwordOrMode);
    } else {
      result = await login(emailOrUsername, passwordOrEmail);
    }

    if (result.success) {
      setShowAuthModal(false);
    } else {
      throw new Error(result.error);
    }
  };

  const handleFileUpload = async (fileOrFolder, options = {}) => {
    if (!user || !token) {
      alert('Please log in to upload files');
      return;
    }

    setShowUploadModal(false);

    // Handle folder upload
    if (fileOrFolder && fileOrFolder.files && Array.isArray(fileOrFolder.files)) {
      const { folderName, files } = fileOrFolder;

      setUploading(true);
      setUploadProgress({ progress: 0, speed: 0, timeRemaining: 0, fileName: folderName });

      let uploadedCount = 0;
      let skippedCount = 0;
      const failures = []; // { name, reason }

      for (const { file, relativePath } of files) {
        if (file.size > CLOUD_UPLOAD_MAX_BYTES) {
          skippedCount++;
          failures.push({ name: file.name, reason: `Too large (> ${CLOUD_UPLOAD_MAX_LABEL})` });
          continue;
        }

        setUploadProgress({
          progress: Math.round((uploadedCount / files.length) * 100),
          speed: 0,
          timeRemaining: 0,
          fileName: `${folderName} (${uploadedCount + 1}/${files.length})`
        });

        const formData = new FormData();
        formData.append('file', file);
        if (options.isPublic !== undefined) formData.append('is_public', options.isPublic);
        if (options.sharedWith) formData.append('shared_with', options.sharedWith);
        formData.append('folder_path', `${folderName}/${relativePath}`);

        try {
          await axios.post(`${API}/upload`, formData, {
            headers: {
              'Content-Type': 'multipart/form-data',
              'Authorization': `Bearer ${token}`
            }
          });
          uploadedCount++;
        } catch (error) {
          const status = error.response?.status;
          const detail = error.response?.data?.detail || error.message || 'Unknown error';
          let reason = detail;
          if (status === 403) {
            reason = 'Data limit reached (2GB)';
            setDataLimitReached(true);
            failures.push({ name: file.name, reason });
            break; // stop trying, limit reached
          } else if (status === 413) {
            reason = `Too large (> ${CLOUD_UPLOAD_MAX_LABEL})`;
          } else if (status === 429) {
            reason = 'Rate limit exceeded (30/min)';
          }
          failures.push({ name: file.name, reason });
        }
      }

      await fetchFiles();

      // Build a detailed report
      const totalFailed = failures.length;
      if (totalFailed > 0 || skippedCount > 0) {
        let msg = `Folder "${folderName}" upload complete:\n${uploadedCount} uploaded`;
        if (skippedCount > 0) msg += `, ${skippedCount} skipped (too large)`;
        if (totalFailed > 0) msg += `, ${totalFailed} failed`;
        msg += '\n\nFailed files:';
        for (const f of failures.slice(0, 8)) {
          msg += `\n• ${f.name}: ${f.reason}`;
        }
        if (failures.length > 8) msg += `\n...and ${failures.length - 8} more`;
        window.alert(msg);
      }

      setTimeout(() => {
        setUploadProgress(null);
      }, 2000);

      setUploading(false);
      return;
    }

    // Handle single file upload (existing logic)
    const file = fileOrFolder;

    // Handle Google Drive Import
    if (file.source === 'google_drive') {
      try {
        const params = new URLSearchParams({
          is_public: options.isPublic !== undefined ? options.isPublic : true,
          shared_with: options.sharedWith || ''
        });

        const response = await axios.post(
          `${API}/drive/share/${file.id}?${params}`,
          {},
          { headers: { Authorization: `Bearer ${token}` } }
        );

        alert(`"${file.name}" has been imported to UniShare!`);
        await fetchFiles();
      } catch (error) {
        console.error('Import failed:', error);
        alert(error.response?.data?.detail || 'Failed to import file to UniShare');
      }
      return;
    }

    if (file.size > CLOUD_UPLOAD_MAX_BYTES) {
      window.dispatchEvent(new CustomEvent('app-toast', {
        detail: {
          message: `"${file.name}" is too large to upload (limit ${CLOUD_UPLOAD_MAX_LABEL}). Send it directly to a peer instead.`,
          kind: 'error'
        }
      }));
      return;
    }

    setUploading(true);
    setUploadProgress({ progress: 0, speed: 0, timeRemaining: 0, fileName: file.name });

    const formData = new FormData();
    formData.append('file', file);
    if (options.isPublic !== undefined) formData.append('is_public', options.isPublic);
    if (options.sharedWith) formData.append('shared_with', options.sharedWith);

    const startTime = Date.now();
    let lastLoaded = 0;
    let lastTime = startTime;

    try {
      await axios.post(`${API}/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${token}`
        },
        onUploadProgress: (progressEvent) => {
          const currentTime = Date.now();
          const timeElapsed = (currentTime - lastTime) / 1000;
          const loaded = progressEvent.loaded;
          const total = progressEvent.total;
          const percentage = Math.round((loaded * 100) / total);

          const bytesUploaded = loaded - lastLoaded;
          const speed = timeElapsed > 0 ? bytesUploaded / timeElapsed : 0;

          const bytesRemaining = total - loaded;
          const timeRemaining = speed > 0 ? bytesRemaining / speed : 0;

          setUploadProgress({
            progress: percentage,
            speed: speed,
            timeRemaining: timeRemaining,
            fileName: file.name
          });

          lastLoaded = loaded;
          lastTime = currentTime;
        }
      });

      await fetchFiles();

      setTimeout(() => {
        setUploadProgress(null);
      }, 2000);

      setDataLimitReached(false);
    } catch (error) {
      console.error('Upload failed:', error);
      if (error.response?.status === 403) {
        setDataLimitReached(true);
        alert(error.response?.data?.detail || 'Data limit reached. Please create an account.');
      } else {
        alert('Failed to upload file');
      }
      setUploadProgress(null);
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (file) => {
    try {
      setDownloadProgress({ progress: 0, speed: 0, timeRemaining: 0, fileName: file.original_filename });

      const downloadUrl = `${BACKEND_URL}${file.download_url}`;
      const startTime = Date.now();
      let lastLoaded = 0;
      let lastTime = startTime;

      const response = await axios.get(downloadUrl, {
        responseType: 'blob',
        headers: { Authorization: `Bearer ${token}` }, // Add auth header for private files
        onDownloadProgress: (progressEvent) => {
          const currentTime = Date.now();
          const timeElapsed = (currentTime - lastTime) / 1000;
          const loaded = progressEvent.loaded;
          const total = progressEvent.total || progressEvent.loaded;
          const percentage = total > 0 ? Math.round((loaded * 100) / total) : 100;

          const bytesDownloaded = loaded - lastLoaded;
          const speed = timeElapsed > 0 ? bytesDownloaded / timeElapsed : 0;

          const bytesRemaining = total - loaded;
          const timeRemaining = speed > 0 ? bytesRemaining / speed : 0;

          setDownloadProgress({
            progress: percentage,
            speed: speed,
            timeRemaining: timeRemaining,
            fileName: file.original_filename
          });

          lastLoaded = loaded;
          lastTime = currentTime;
        }
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', file.original_filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      setTimeout(() => {
        setDownloadProgress(null);
      }, 2000);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Failed to download file. You may not have permission.');
      setDownloadProgress(null);
    }
  };

  const handleDelete = (file) => {
    setPendingDelete(file);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await axios.delete(`${API}/files/${pendingDelete.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      await fetchFiles();
      showToast(`Deleted "${pendingDelete.original_filename}"`, 'success');
      setPendingDelete(null);
    } catch (error) {
      console.error('Delete failed:', error);
      const detail = error.response?.data?.detail || 'Failed to delete file';
      showToast(detail, 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleDownloadFolder = (folder) => {
    const authToken = getAuthToken() || '';
    const link = document.createElement('a');
    link.href = `${API}/files/download-folder?folder_path=${encodeURIComponent(folder.folderName)}&token=${encodeURIComponent(authToken)}`;
    link.setAttribute('download', '');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDeleteFolder = async (folder) => {
    if (!folder.files || folder.files.length === 0) return;
    const confirmed = window.confirm(`Delete folder "${folder.folderName}" and all ${folder.files.length} files inside?`);
    if (!confirmed) return;
    setDeleteBusy(true);
    let deleted = 0;
    let failed = 0;
    for (const file of folder.files) {
      try {
        await axios.delete(`${API}/files/${file.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        deleted++;
      } catch (error) {
        failed++;
        console.error(`Failed to delete ${file.id}:`, error);
      }
    }
    await fetchFiles();
    if (failed > 0) {
      showToast(`Deleted ${deleted} files, ${failed} failed`, 'warning');
    } else {
      showToast(`Deleted folder "${folder.folderName}"`, 'success');
    }
    setDeleteBusy(false);
  };

  const handleShare = (file) => {
    setSelectedFile(file);
    setShowShareModal(true);
  };

  const handleConnectDrive = async () => {
    if (isOfflineMode()) {
      showToast('Google Drive requires internet. Offline mode is enabled.', 'info');
      setDriveConfigured(false);
      return;
    }

    try {
      const response = await axios.get(`${API}/drive/connect`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      window.location.href = response.data.authorization_url;
    } catch (error) {
      console.error('Failed to connect Drive:', error);
      const errorMsg = error.response?.data?.detail || 'Failed to connect Google Drive';
      if (errorMsg.includes('not configured')) {
        setDriveConfigured(false);
        showToast('Google Drive is not configured on the server.', 'error');
      } else {
        showToast(errorMsg, 'error');
      }
    }
  };

  const handleWelcomeGetStarted = () => {
    // Start welcome exit
    setWelcomeExiting(true);
    // Mount login page (invisible)
    setShowLoginPage(true);
    setLoginVisible(false);
    // Staggered: start login entrance after welcome begins exiting
    setTimeout(() => setLoginVisible(true), 350);
    // Unmount welcome after its exit transition completes
    setTimeout(() => {
      setShowWelcome(false);
      setWelcomeExiting(false);
    }, 750);
  };

  const handleBackToWelcome = () => {
    // Start login exit
    setLoginVisible(false);
    // Mount welcome page (invisible)
    setShowWelcome(true);
    setWelcomeVisible(false);
    // Staggered: start welcome entrance after login begins exiting
    setTimeout(() => setWelcomeVisible(true), 350);
    // Unmount login after its exit transition completes
    setTimeout(() => {
      setShowLoginPage(false);
    }, 750);
  };

  const handleDriveConnectNow = async () => {
    setShowDriveConnectModal(false);
    await handleConnectDrive();
  };

  const handleDriveConnectSkip = () => {
    setShowDriveConnectModal(false);
  };

  const handleSaveToDrive = async (file) => {
    if (!user || !token) {
      alert('Please log in to save to Drive');
      return;
    }
    if (!user.google_drive_connected) {
      alert('Please connect your Google Drive first');
      return;
    }
    try {
      const response = await axios.post(
        `${API}/drive/save/${file.id}`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data.success) {
        alert(`File saved to Google Drive! ${response.data.drive_link}`);
      }
    } catch (error) {
      console.error('Failed to save to Drive:', error);
      alert(error.response?.data?.detail || 'Failed to save file to Google Drive');
    }
  };

  const handleLogout = () => {
    logout();
    setFiles([]);
    webrtcManager.disconnect();
    // Hide welcome so only login page shows after logout
    setShowWelcome(false);
    setWelcomeVisible(false);
    setShowLoginPage(true);
    setLoginVisible(true);
    navigate('/');
  };

  // Shared ambient background for all pre-auth screens (single canvas, no reset)
  const sharedAmbient = (
    <div
      key="shared-ambient"
      className="dark fixed inset-0 overflow-hidden text-white pointer-events-none"
      style={{ zIndex: 0 }}
    >
      <AmbientBackground />
    </div>
  );

  // Epic loading screen → welcome crossfade (sequential: loading exits fully before welcome fades in)
  if (showLoading && !location.pathname.startsWith('/receive')) {
    return (
      <>
        {sharedAmbient}
        <LoadingScreen
          onBeginExit={() => {
            /* sequential transition: wait until loading is gone before mounting welcome */
          }}
          onFinished={() => {
            setShowLoading(false);
            setShowWelcome(true);
          }}
          minDuration={3200}
        />
      </>
    );
  }

  if (authLoading && !location.pathname.startsWith('/receive')) {
    return (
      <>
        {sharedAmbient}
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600 dark:text-gray-400">Loading...</p>
          </div>
        </div>
      </>
    );
  }

  // Unified welcome ↔ login transition area
  const showWelcomeLayer = (showWelcome || welcomeExiting) && !location.pathname.startsWith('/receive');
  const showLoginLayer = showLoginPage && !user && !location.pathname.startsWith('/receive');

  if (showWelcomeLayer || showLoginLayer) {
    return (
      <>
        {sharedAmbient}
        <div className="fixed inset-0 z-10">
          {showWelcomeLayer && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: welcomeExiting ? 0 : welcomeVisible ? 1 : 0,
                transition: 'opacity 700ms cubic-bezier(0.16, 1, 0.3, 1)',
                pointerEvents: welcomeExiting ? 'none' : 'auto',
              }}
            >
              <WelcomeScreen onGetStarted={handleWelcomeGetStarted} />
            </div>
          )}
          {showLoginLayer && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: loginVisible ? 1 : 0,
                transition: 'opacity 700ms cubic-bezier(0.16, 1, 0.3, 1)',
                pointerEvents: loginVisible ? 'auto' : 'none',
              }}
            >
              <LoginPage
                onSuccess={handleAuth}
                onGuestMode={() => {
                  setShowLoginPage(false);
                  setShowGuestModal(true);
                }}
                onBack={handleBackToWelcome}
              />
            </div>
          )}
        </div>
      </>
    );
  }

  // Handle /receive route for unauthenticated users (P2P file receipt)
  if (location.pathname === '/receive') {
    return <ReceiveFileView />;
  }

  return (
    <div className="min-h-screen relative overflow-y-auto overflow-x-hidden flex flex-col">
      <AmbientBackground density="sparse" />

      {/* Header */}
      <header className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 sticky top-0 z-40 backdrop-blur-sm bg-white/90 dark:bg-slate-800/90">
        <div className="max-w-7xl mx-auto px-2 sm:px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14 sm:h-16">
            <div className="flex items-center space-x-2 sm:space-x-3">
              <div className="relative w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 shadow-lg flex items-center justify-center">
                <Share2 className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                <Zap className="absolute -top-0.5 -right-0.5 w-3 h-3 sm:w-4 sm:h-4 text-yellow-400 fill-yellow-400" />
              </div>
              <div>
                <h1 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-white">UniShare</h1>
                <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 hidden sm:block">Fast & Secure File Sharing</p>
              </div>
            </div>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center space-x-4">
              <Link
                to="/"
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${location.pathname === '/'
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
              >
                <div className="flex items-center space-x-2">
                  <FileText className="w-4 h-4" />
                  <span>Files</span>
                </div>
              </Link>
              <Link
                to="/chat"
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${location.pathname === '/chat'
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
              >
                <div className="flex items-center space-x-2">
                  <MessageCircle className="w-4 h-4" />
                  <span>Chat</span>
                </div>
              </Link>
              <Link
                to="/drive"
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${location.pathname === '/drive'
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
              >
                <div className="flex items-center space-x-2">
                  <HardDrive className="w-4 h-4" />
                  <span>Google Drive</span>
                </div>
              </Link>
              <Link
                to="/history"
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${location.pathname === '/history'
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
              >
                <div className="flex items-center space-x-2">
                  <History className="w-4 h-4" />
                  <span>History</span>
                </div>
              </Link>
              {user && user.is_admin && (
                <Link
                  to="/admin"
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${location.pathname === '/admin'
                    ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                    }`}
                >
                  <div className="flex items-center space-x-2">
                    <span>🛡️</span>
                    <span>Admin</span>
                  </div>
                </Link>
              )}
            </nav>

            <div className="flex items-center space-x-3">
              {user && (
                <>
                  {driveConfigured && !user.google_drive_connected && (
                    <button
                      onClick={handleConnectDrive}
                      className="hidden sm:flex items-center space-x-2 px-4 py-2 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-600 transition-colors"
                    >
                      <HardDrive className="w-4 h-4" />
                      <span className="text-sm">Connect Drive</span>
                    </button>
                  )}

                  <button
                    onClick={() => !user.is_guest && setShowAvatarPicker(true)}
                    disabled={user.is_guest}
                    title={user.is_guest ? 'Sign in to set an avatar' : 'Change avatar & username'}
                    className={`hidden sm:flex items-center space-x-2 px-3 py-2 bg-gray-100 dark:bg-slate-700 rounded-lg ${user.is_guest ? 'cursor-default' : 'hover:bg-gray-200 dark:hover:bg-slate-600 cursor-pointer'}`}
                  >
                    {user.avatar_url ? (
                      <img src={user.avatar_url} alt="avatar" className="w-7 h-7 rounded-full bg-white" />
                    ) : (
                      <span className="text-xl">{user.emoji}</span>
                    )}
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {user.username}
                    </span>
                    {!user.is_guest && (
                      <Pencil className="w-3.5 h-3.5 text-gray-400" />
                    )}
                    {user.is_guest && (
                      <span className="text-xs px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 rounded">
                        Guest
                      </span>
                    )}
                  </button>
                </>
              )}

              <button
                onClick={toggleTheme}
                className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
              </button>

              {user && (
                <button
                  onClick={handleLogout}
                  className="p-2 text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              )}

              {/* Mobile Menu Button */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-4 py-2 space-y-1">
            <Link
              to="/"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg text-base font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              Files
            </Link>
            <Link
              to="/chat"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg text-base font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              Chat
            </Link>
            <Link
              to="/drive"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg text-base font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              Google Drive
            </Link>
            <Link
              to="/history"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg text-base font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              History
            </Link>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-2 sm:px-4 sm:px-6 lg:px-8 py-3 sm:py-8 relative z-10 overflow-y-auto">
        {user && (
          <Routes>
            <Route path="/" element={
              <>
                {/* Data Limit Warning */}
                {user.is_guest && user.total_data_shared > GUEST_DATA_LIMIT * 0.8 && (
                  <div className="mb-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                          You've used {((user.total_data_shared / GUEST_DATA_LIMIT) * 100).toFixed(0)}% of your 2GB guest limit
                        </p>
                        <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
                          Create an account to get unlimited storage!
                        </p>
                      </div>
                      <button
                        onClick={() => setShowAuthModal(true)}
                        className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white text-sm font-medium rounded-lg transition-colors"
                      >
                        Upgrade Now
                      </button>
                    </div>
                  </div>
                )}

                {/* Upload Zone */}
                <div className="mb-8">
                  <UploadZone
                    onFileSelect={(file) => {
                      setSelectedFile(file); // Store file or folder temporarily
                      setShowUploadModal(true); // Open modal for both files and folders
                    }}
                    uploading={uploading}
                    disabled={uploading}
                  />
                  {dataLimitReached && (
                    <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-center">
                      <p className="text-sm text-red-800 dark:text-red-200 font-medium">
                        2GB limit reached for guests
                      </p>
                      <button
                        onClick={() => setShowAuthModal(true)}
                        className="mt-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
                      >
                        Create Account for Unlimited Storage
                      </button>
                    </div>
                  )}
                </div>

                {/* Files Grid — split into My Files vs Public Files */}
                {(() => {
                  const myFiles = files.filter((f) => f.owner_id === user.id);
                  const publicFiles = files.filter((f) => f.owner_id !== user.id);

                  const groupFilesByFolder = (list) => {
                    const folders = {};
                    const individualFiles = [];
                    for (const file of list) {
                      if (file.folder_path) {
                        const folderName = file.folder_path.split('/')[0];
                        if (!folders[folderName]) {
                          folders[folderName] = {
                            folderName,
                            files: [],
                            totalSize: 0,
                            fileCount: 0,
                            owner_id: file.owner_id,
                            owner_username: file.owner_username,
                            owner_type: file.owner_type,
                          };
                        }
                        folders[folderName].files.push(file);
                        folders[folderName].totalSize += file.size || 0;
                        folders[folderName].fileCount += 1;
                      } else {
                        individualFiles.push(file);
                      }
                    }
                    return { folders: Object.values(folders), individualFiles };
                  };

                  const renderGrid = (list) => {
                    const { folders, individualFiles } = groupFilesByFolder(list);
                    return (
                      <div className="grid gap-3 sm:gap-4 grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 lg:grid-cols-3">
                        {folders.map((folder) => (
                          <FolderCard
                            key={`folder-${folder.folderName}`}
                            folder={folder}
                            onDownload={handleDownloadFolder}
                            onDelete={handleDeleteFolder}
                            user={user}
                          />
                        ))}
                        {individualFiles.map((file) => (
                          <FileCard
                            key={file.id}
                            file={file}
                            onDownload={handleDownload}
                            onDelete={handleDelete}
                            onShare={handleShare}
                            onSaveToDrive={handleSaveToDrive}
                            onPreview={(f) => {
                              setPreviewFile(f);
                              setShowPreviewModal(true);
                            }}
                            user={user}
                            token={token}
                          />
                        ))}
                      </div>
                    );
                  };

                  const { folders: myFolders, individualFiles: myIndividual } = groupFilesByFolder(myFiles);
                  const { folders: publicFolders, individualFiles: publicIndividual } = groupFilesByFolder(publicFiles);
                  const myCount = myFolders.length + myIndividual.length;
                  const publicCount = publicFolders.length + publicIndividual.length;

                  return (
                    <>
                      <div className="mb-8">
                        <div className="flex items-center justify-between mb-4">
                          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                            My Files
                            <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                              ({myCount})
                            </span>
                          </h2>
                          {user.is_guest && (
                            <button
                              onClick={() => setShowAuthModal(true)}
                              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              Login to access everywhere
                            </button>
                          )}
                        </div>
                        {myCount === 0 ? (
                          <div className="text-center py-10 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                            <UploadIcon className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                            <p className="text-gray-600 dark:text-gray-400">You haven't uploaded any files yet</p>
                          </div>
                        ) : (
                          renderGrid(myFiles)
                        )}
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-4">
                          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                            Public Files
                            <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                              ({publicCount})
                            </span>
                          </h2>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            uploaded by other users
                          </span>
                        </div>
                        {publicCount === 0 ? (
                          <div className="text-center py-10 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                            <p className="text-sm text-gray-500 dark:text-gray-400">No public files shared yet</p>
                          </div>
                        ) : (
                          renderGrid(publicFiles)
                        )}
                      </div>
                    </>
                  );
                })()}
              </>
            } />
            <Route path="/drive" element={
              <GoogleDriveView
                token={token}
                user={user}
                onFileSelect={(file) => {
                  setSelectedFile({ ...file, source: 'google_drive' });
                  setShowUploadModal(true);
                }}
              />
            } />
            <Route path="/history" element={<HistoryView token={token} />} />
            <Route path="/receive" element={<ReceiveFileView />} />
            <Route path="/chat" element={<ChatView token={token} currentUser={user} />} />
            {user && user.is_admin && (
              <Route path="/admin" element={<AdminView token={token} currentUser={user} />} />
            )}
          </Routes>
        )}
      </main>

      {/* File Preview Modal */}
      {showPreviewModal && previewFile && (
        <FilePreviewModal
          file={previewFile}
          token={token}
          onClose={() => {
            setShowPreviewModal(false);
            setPreviewFile(null);
          }}
        />
      )}

      <ConfirmModal
        open={!!pendingDelete}
        title="Delete file?"
        message={
          pendingDelete
            ? `"${pendingDelete.original_filename}" will be permanently removed from the server. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => !deleteBusy && setPendingDelete(null)}
      />

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-[90] px-4 py-3 rounded-lg shadow-lg text-sm font-medium max-w-md ${
            toast.kind === 'error'
              ? 'bg-red-600 text-white'
              : toast.kind === 'info'
              ? 'bg-slate-800 text-white'
              : 'bg-green-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* P2P received file preview */}
      <P2PReceivedPreviewModal
        received={receivedFile}
        onClose={() => setReceivedFile(null)}
      />

      {/* Progress Indicators */}
      {uploadProgress && (
        <ProgressIndicator
          type="upload"
          fileName={uploadProgress.fileName}
          progress={uploadProgress.progress}
          speed={uploadProgress.speed}
          timeRemaining={uploadProgress.timeRemaining}
        />
      )}

      {downloadProgress && (
        <ProgressIndicator
          type="download"
          fileName={downloadProgress.fileName}
          progress={downloadProgress.progress}
          speed={downloadProgress.speed}
          timeRemaining={downloadProgress.timeRemaining}
        />
      )}

      {/* Modals */}
      <GuestModal
        isOpen={showGuestModal && !user}
        onClose={() => { setShowGuestModal(false); setShowLoginPage(true); setGuestLoginError(''); }}
        onSubmit={handleGuestLogin}
        error={guestLoginError}
        onClearError={() => setGuestLoginError('')}
      />

      <ProfileModal
        open={showAvatarPicker && !!user && !user.is_guest}
        onClose={() => setShowAvatarPicker(false)}
        token={token}
        user={user}
        onUpdated={(updates) => setUser((prev) => prev ? { ...prev, ...updates } : prev)}
      />

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={handleAuth}
      />

      {selectedFile && showShareModal && (
        <ShareModal2
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          file={selectedFile}
          backendUrl={BACKEND_URL}
        />
      )}

      {/* Upload Options Modal */}
      <UploadOptionsModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onUpload={handleFileUpload}
        file={selectedFile}
        uploading={uploading}
        dataLimitReached={dataLimitReached}
      />

      {user && driveConfigured && user.google_drive_connected && (
        <GoogleDrivePicker
          isOpen={showDrivePicker}
          onClose={() => setShowDrivePicker(false)}
          onFileShared={(file) => {
            setShowDrivePicker(false);
            fetchFiles();
          }}
          token={token}
        />
      )}

      {/* Google Drive Connect Modal */}
      <GoogleDriveConnectModal
        isOpen={showDriveConnectModal}
        onConnect={handleDriveConnectNow}
        onSkip={handleDriveConnectSkip}
      />

      {/* Rename Modal */}
      
    </div>
  );
}

export default App;
