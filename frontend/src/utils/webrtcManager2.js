// Enhanced WebRTC Manager with DataChannels for P2P file sharing
import { getWebRtcIceServers, isOfflineMode } from './offline';
import { getAuthToken } from './authStorage';

class WebRTCManager {
  constructor() {
    this.ws = null;
    this.userId = null;
    this.username = null;
    this.emoji = null;
    this.peers = new Map(); // Map of peer connections
    this.dataChannels = new Map(); // Map of data channels
    this.onlineUsers = [];
    this.onOnlineUsersChange = null;
    this.onFileReceived = null;
    this.onFileOffered = null;
    this.onProgressUpdate = null;
    this.onChatEvent = null;
    this.onFileUploaded = null; // Callback for file upload notifications
    this.pendingFiles = new Map(); // Files hosted for link-based pickup
    this.pendingSends = new Map(); // Files awaiting offer accept/decline
    this.receivingFiles = new Map(); // Files being received
    this.pendingIceCandidates = new Map(); // ICE candidates queued before remoteDescription is set
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.broadcastChannel = null;
    this.broadcastPeers = new Map();
    this.presenceInterval = null;
    this.wsConnected = false;
    this.reconnectTimer = null;
    this.manualDisconnect = false;
  }

  connect(userId, backendUrl, username = null, emoji = null) {
    this.manualDisconnect = false;
    this.userId = userId;
    this.backendUrl = backendUrl;
    // Preserve existing username/emoji on reconnect if not explicitly provided
    this.username = username || this.username || 'Anonymous';
    this.emoji = emoji || this.emoji || '👤';

    if (isOfflineMode()) {
      this.enableBroadcastSignaling();
    }

    if (!backendUrl) {
      if (this.enableBroadcastSignaling()) {
        return;
      }
      console.warn('WebRTC signaling requires a backend URL. Skipping WebSocket connection.');
      return;
    }

    if (this.ws) {
      // Replacing socket intentionally; do not trigger reconnect from old onclose.
      this.ws.__skipReconnect = true;
      this.ws.close();
      this.ws = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const wsUrl = backendUrl.replace('https://', 'wss://').replace('http://', 'ws://');

    // Add query parameters for username and emoji if provided
    let url = `${wsUrl}/api/ws/${userId}`;
    const params = new URLSearchParams();
    if (username) params.append('username', username);
    if (emoji) params.append('emoji', emoji);
    const token = getAuthToken();
    if (token) params.append('token', token);

    if (params.toString()) {
      url += `?${params.toString()}`;
    }

    this.ws = new WebSocket(url);
    this.wsConnected = false;

    this.ws.onopen = () => {
      this.wsConnected = true;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleSignalPayload(data);
      } catch (e) {
        console.error('[WebRTC] Failed to parse message:', e);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (!this.wsConnected && isOfflineMode()) {
        this.enableBroadcastSignaling();
      }
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket closed');
      if (event?.target?.__skipReconnect) {
        return;
      }
      if (this.manualDisconnect || event?.code === 4401) {
        return; // 4401: the server rejected our token; retrying will not help
      }
      if (!this.backendUrl) {
        return;
      }
      if (!this.wsConnected && isOfflineMode()) {
        this.enableBroadcastSignaling();
        return;
      }
      // Attempt to reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts && !this.reconnectTimer) {
        this.reconnectAttempts++;
        const attempt = this.reconnectAttempts;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          console.log(`Reconnecting... Attempt ${attempt}`);
          this.connect(this.userId, this.backendUrl, this.username, this.emoji);
        }, 2000 * attempt);
      }
    };
  }

  updateUserInfo(username, emoji) {
    this.username = username || this.username;
    this.emoji = emoji || this.emoji;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'update_info',
        username,
        emoji
      }));
    } else if (this.broadcastChannel) {
      this.broadcastPresence();
    }
  }

  async createPeerConnection(peerId, isInitiator = true) {
    const configuration = {
      iceServers: getWebRtcIceServers()
    };

    const peerConnection = new RTCPeerConnection(configuration);
    this.peers.set(peerId, peerConnection);

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        const sent = this.sendSignal({
          type: 'ice-candidate',
          target: peerId,
          candidate: event.candidate
        });
        if (!sent) {
          console.warn('Signaling channel not ready. ICE candidate skipped.');
        }
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log(`🔄 ICE connection state with ${peerId}:`, peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
        console.error(`❌ ICE connection ${peerConnection.iceConnectionState} with ${peerId}`);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log(`🔄 Connection state with ${peerId}:`, peerConnection.connectionState);
    };

    // Create data channel if initiator
    if (isInitiator) {
      const dataChannel = peerConnection.createDataChannel('fileTransfer', {
        ordered: true
      });
      this.setupDataChannel(peerId, dataChannel);
    } else {
      // Wait for data channel
      peerConnection.ondatachannel = (event) => {
        this.setupDataChannel(peerId, event.channel);
      };
    }

    return peerConnection;
  }

  setupDataChannel(peerId, dataChannel) {
    this.dataChannels.set(peerId, dataChannel);
    console.log(`Setting up data channel with ${peerId}, readyState:`, dataChannel.readyState);

    dataChannel.onopen = () => {
      console.log(`✅ Data channel OPEN with ${peerId}`);
    };

    dataChannel.onclose = () => {
      console.log(`❌ Data channel CLOSED with ${peerId}`);
      this.dataChannels.delete(peerId);
    };

    dataChannel.onerror = (error) => {
      console.error(`❌ Data channel ERROR with ${peerId}:`, error);
    };

    dataChannel.onmessage = (event) => {
      this.handleDataChannelMessage(peerId, event.data);
    };
  }

  // New: Host a file for P2P sharing without immediate transfer
  hostFile(file) {
    const fileId = Math.random().toString(36).substr(2, 9);
    this.pendingFiles.set(fileId, file);
    return fileId;
  }

  // New: Request a specific file from a peer
  async requestFile(peerId, fileId) {
    const dataChannel = this.dataChannels.get(peerId);
    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error('Data channel not ready');
    }

    console.log(`Requesting file ${fileId} from ${peerId}`);
    dataChannel.send(JSON.stringify({
      type: 'request-file',
      fileId
    }));
  }

  // Receiver responds to an incoming file-offer
  respondToOffer(peerId, fileId, accepted) {
    const dataChannel = this.dataChannels.get(peerId);
    if (!dataChannel || dataChannel.readyState !== 'open') {
      console.error('Cannot respond to offer: data channel not open');
      return false;
    }
    dataChannel.send(JSON.stringify({
      type: 'file-offer-response',
      fileId,
      accepted: !!accepted
    }));
    return true;
  }

  async handleDataChannelMessage(peerId, data) {
    // Parse message
    if (typeof data === 'string') {
      const message = JSON.parse(data);

      if (message.type === 'request-file') {
        const file = this.pendingFiles.get(message.fileId);
        if (file) {
          this.sendFileWithId(peerId, file, message.fileId, this.onProgressUpdate);
        }
      } else if (message.type === 'file-metadata') {
        // Initialize file reception
        this.receivingFiles.set(message.fileId, {
          name: message.name,
          size: message.size,
          type: message.mimeType,
          chunks: [],
          receivedSize: 0,
          totalChunks: message.totalChunks,
          sender: message.sender || null
        });

        // Notify about starting to receive
        if (this.onProgressUpdate) {
          this.onProgressUpdate({
            type: 'receiving',
            peerId,
            fileName: message.name,
            sender: message.sender || null,
            progress: 0,
            speed: 0,
            timeRemaining: 0
          });
        }
      } else if (message.type === 'file-chunk') {
        // Store chunk information
        const fileInfo = this.receivingFiles.get(message.fileId);
        if (fileInfo) {
          // Decode base64 chunk to binary
          const binaryString = atob(message.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          fileInfo.chunks[message.index] = bytes;
          fileInfo.receivedSize += bytes.length;

          const progress = (fileInfo.receivedSize / fileInfo.size) * 100;

          // Update progress
          if (this.onProgressUpdate) {
            this.onProgressUpdate({
              type: 'receiving',
              peerId,
              fileName: fileInfo.name,
              progress: Math.round(progress),
              speed: 0, // Can calculate if needed
              timeRemaining: 0
            });
          }

          // Check if all chunks received
          if (message.index === message.totalChunks - 1) {
            // Reconstruct file from all chunks
            const blob = new Blob(fileInfo.chunks, { type: fileInfo.type });

            console.log('File received via P2P:', fileInfo.name, 'Size:', blob.size);

            // Trigger file received callback
            if (this.onFileReceived) {
              this.onFileReceived(fileInfo.name, blob, peerId, {
                sender: fileInfo.sender,
                size: fileInfo.size,
                mimeType: fileInfo.type
              });
            }

            // Clean up
            this.receivingFiles.delete(message.fileId);
          }
        }
      }
    } else {
      // Binary data (chunk)
      // This is handled in the string message parsing above
    }
  }

  canSendViaBroadcast(peerId) {
    const can = !!(this.broadcastChannel && this.broadcastPeers.has(peerId));
    console.log('[BC] canSendViaBroadcast', {
      peerId,
      hasChannel: !!this.broadcastChannel,
      broadcastPeers: Array.from(this.broadcastPeers.keys()),
      result: can
    });
    return can;
  }

  async sendFile(peerId, file, onProgress) {
    // Same-browser tabs: use BroadcastChannel (no NAT/ICE/mDNS issues)
    if (this.canSendViaBroadcast(peerId)) {
      return this.sendFileViaBroadcast(peerId, file, onProgress);
    }

    const dataChannel = this.dataChannels.get(peerId);
    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error('Data channel not ready');
    }

    const fileId = Math.random().toString(36).substr(2, 9);

    return new Promise((resolve, reject) => {
      try {
        this.sendFileWithId(peerId, file, fileId, onProgress, resolve);
      } catch (err) {
        reject(err);
      }
    });
  }

  async sendFileViaBroadcast(peerId, file, onProgress) {
    if (!this.broadcastChannel) throw new Error('Broadcast channel unavailable');

    const fileId = Math.random().toString(36).substr(2, 9);
    // Bigger chunks for big files: fewer postMessage calls, less per-chunk overhead.
    // File.slice() streams from disk — sender never holds the whole file in RAM.
    const CHUNK_SIZE = file.size > 100 * 1024 * 1024
      ? 4 * 1024 * 1024   // 4MB for files > 100MB
      : 256 * 1024;        // 256KB otherwise
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;

    this.broadcastChannel.postMessage({
      type: 'bc-file-metadata',
      target: peerId,
      sender: this.userId,
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      totalChunks,
      senderInfo: {
        userId: this.userId,
        username: this.username,
        emoji: this.emoji
      }
    });

    let offset = 0;
    let chunkIndex = 0;
    const startTime = Date.now();

    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      this.broadcastChannel.postMessage({
        type: 'bc-file-chunk',
        target: peerId,
        sender: this.userId,
        fileId,
        index: chunkIndex,
        data: buffer,
        totalChunks
      });

      offset += buffer.byteLength;
      chunkIndex++;

      const progress = (offset / file.size) * 100;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed = offset / elapsed;
      const remaining = speed > 0 ? (file.size - offset) / speed : 0;

      if (onProgress) {
        onProgress({
          progress: Math.round(progress),
          speed,
          timeRemaining: remaining
        });
      }

      // Yield to event loop so UI updates and BC messages flush
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (file.size === 0) {
      // Empty file: at least send a zero-byte final chunk so receiver finalizes
      this.broadcastChannel.postMessage({
        type: 'bc-file-chunk',
        target: peerId,
        sender: this.userId,
        fileId,
        index: 0,
        data: new ArrayBuffer(0),
        totalChunks: 1
      });
    }

    console.log('File sent via BroadcastChannel');
  }

  async sendFileWithId(peerId, file, fileId, onProgress, onComplete) {
    const dataChannel = this.dataChannels.get(peerId);

    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error('Data channel not ready');
    }

    const CHUNK_SIZE = 16384; // 16KB chunks
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Send file metadata (includes sender so receiver UI can show who it's from)
    dataChannel.send(JSON.stringify({
      type: 'file-metadata',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      totalChunks,
      sender: {
        userId: this.userId,
        username: this.username,
        emoji: this.emoji
      }
    }));

    // Send file in chunks
    const reader = new FileReader();
    let offset = 0;
    let chunkIndex = 0;
    const startTime = Date.now();

    const sendNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (event) => {
      const chunk = event.target.result;
      const chunkData = btoa(String.fromCharCode(...new Uint8Array(chunk)));

      // Send chunk
      dataChannel.send(JSON.stringify({
        type: 'file-chunk',
        fileId,
        index: chunkIndex,
        data: chunkData,
        totalChunks
      }));

      offset += chunk.byteLength;
      chunkIndex++;

      // Calculate progress
      const progress = (offset / file.size) * 100;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = offset / elapsed;
      const remaining = (file.size - offset) / speed;

      if (onProgress) {
        onProgress({
          progress: Math.round(progress),
          speed,
          timeRemaining: remaining
        });
      }

      if (offset < file.size) {
        // Send next chunk with a small delay to avoid overwhelming
        setTimeout(sendNextChunk, 10);
      } else {
        console.log('File sent successfully');
        if (onComplete) onComplete();
      }
    };

    reader.onerror = (error) => {
      console.error('Error reading file:', error);
    };

    sendNextChunk();
  }

  async initiateConnection(peerId) {
    try {
      // Clean up any existing connection for this peer
      this.closePeerConnection(peerId);

      const peerConnection = await this.createPeerConnection(peerId, true);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sent = this.sendSignal({
        type: 'offer',
        target: peerId,
        offer: offer
      });
      if (!sent) {
        throw new Error('Signaling channel not ready');
      }
    } catch (error) {
      console.error('Error initiating connection:', error);
      throw error;
    }
  }

  async handleOffer(peerId, offer) {
    try {
      const peerConnection = await this.createPeerConnection(peerId, false);

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

      // Drain any ICE candidates that arrived before remote description was set
      const pending = this.pendingIceCandidates.get(peerId) || [];
      for (const candidate of pending) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
      }
      this.pendingIceCandidates.delete(peerId);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      const sent = this.sendSignal({
        type: 'answer',
        target: peerId,
        answer: answer
      });
      if (!sent) {
        console.warn('Signaling channel not ready. Answer not sent.');
      }
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }

  async handleAnswer(peerId, answer) {
    try {
      const peerConnection = this.peers.get(peerId);
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

        // Drain any ICE candidates that arrived before the answer
        const pending = this.pendingIceCandidates.get(peerId) || [];
        for (const candidate of pending) {
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
        }
        this.pendingIceCandidates.delete(peerId);
      }
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  }

  async handleIceCandidate(peerId, candidate) {
    const peerConnection = this.peers.get(peerId);
    if (!peerConnection) return;

    if (!peerConnection.remoteDescription) {
      if (!this.pendingIceCandidates.has(peerId)) {
        this.pendingIceCandidates.set(peerId, []);
      }
      this.pendingIceCandidates.get(peerId).push(candidate);
      return;
    }

    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  }

  closePeerConnection(peerId) {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection) {
      peerConnection.close();
      this.peers.delete(peerId);
    }

    const dataChannel = this.dataChannels.get(peerId);
    if (dataChannel) {
      dataChannel.close();
      this.dataChannels.delete(peerId);
    }

    this.pendingIceCandidates.delete(peerId);
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close all peer connections
    for (const peerId of this.peers.keys()) {
      this.closePeerConnection(peerId);
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.__skipReconnect = true;
      this.ws.close();
      this.ws = null;
    }

    this.wsConnected = false;

    if (this.broadcastChannel) {
      this.broadcastPresence({ type: 'presence-leave' });
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }

    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }
  }

  enableBroadcastSignaling() {
    if (typeof BroadcastChannel === 'undefined') {
      return false;
    }
    if (!isOfflineMode()) {
      return false;
    }
    if (this.broadcastChannel) {
      return true;
    }

    console.log('[BC] Enabling BroadcastChannel signaling. userId=', this.userId);
    this.broadcastChannel = new BroadcastChannel('unishare-signal');
    this.broadcastChannel.onmessage = (event) => {
      this.handleBroadcastMessage(event.data);
    };

    this.startPresenceLoop();
    this.broadcastPresence();
    this.broadcastChannel.postMessage({
      type: 'presence-request',
      sender: this.userId
    });

    return true;
  }

  startPresenceLoop() {
    if (this.presenceInterval) return;
    this.presenceInterval = setInterval(() => {
      this.broadcastPresence();
      this.pruneBroadcastPeers();
    }, 5000);
  }

  broadcastPresence(extra = {}) {
    if (!this.broadcastChannel) return;
    const payload = {
      type: 'presence',
      sender: this.userId,
      username: this.username || 'Anonymous',
      emoji: this.emoji || '👤',
      timestamp: Date.now(),
      ...extra
    };
    this.broadcastChannel.postMessage(payload);
  }

  pruneBroadcastPeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, info] of this.broadcastPeers.entries()) {
      if (now - info.lastSeen > 15000) {
        this.broadcastPeers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.updateOnlineUsersFromBroadcast();
    }
  }

  updateOnlineUsersFromBroadcast() {
    if (this.wsConnected) return;
    this.onlineUsers = Array.from(this.broadcastPeers.values());
    if (this.onOnlineUsersChange) {
      this.onOnlineUsersChange(this.onlineUsers);
    }
  }

  _finalizeStreamedFile(fileId, fileInfo) {
    const writable = fileInfo.writable;
    if (!writable) return;
    fileInfo.writeQueue = fileInfo.writeQueue
      .then(() => writable.close())
      .then(() => {
        console.log('[BC] Streamed file saved to disk:', fileInfo.name);
        if (this.onFileReceived) {
          this.onFileReceived(fileInfo.name, null, fileInfo.senderPeerId, {
            sender: fileInfo.sender,
            size: fileInfo.size,
            mimeType: fileInfo.type,
            savedToDisk: true
          });
        }
        this.receivingFiles.delete(fileId);
      })
      .catch((err) => { console.error('[BC] Close failed:', err); });
  }

  handleBroadcastMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'presence-request') {
      if (message.sender !== this.userId) {
        this.broadcastPresence();
      }
      return;
    }

    if (message.type === 'presence' || message.type === 'presence-leave') {
      if (message.sender === this.userId) return;
      if (message.type === 'presence-leave') {
        console.log('[BC] presence-leave from', message.sender);
        this.broadcastPeers.delete(message.sender);
        if (!this.wsConnected) this.updateOnlineUsersFromBroadcast();
        return;
      }

      console.log('[BC] presence from', message.sender, message.username);
      this.broadcastPeers.set(message.sender, {
        id: message.sender,
        username: message.username || 'Anonymous',
        emoji: message.emoji || '👤',
        lastSeen: message.timestamp || Date.now()
      });
      if (!this.wsConnected) this.updateOnlineUsersFromBroadcast();
      return;
    }

    if (message.sender && message.sender === this.userId) {
      return;
    }

    if (message.target && message.target !== this.userId) {
      return;
    }

    if (message.type === 'bc-file-metadata') {
      // Stream-to-disk for files > 500MB via File System Access API.
      // Avoids loading multi-GB files into memory on the receiver.
      const STREAM_THRESHOLD = 500 * 1024 * 1024;
      const canStream = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
      const useStreaming = message.size > STREAM_THRESHOLD && canStream;

      const fileInfo = {
        name: message.name,
        size: message.size,
        type: message.mimeType,
        chunks: [],
        receivedSize: 0,
        totalChunks: message.totalChunks,
        sender: message.senderInfo || null,
        senderPeerId: message.sender,
        // Streaming state
        streaming: useStreaming,
        writable: null,
        pendingChunks: useStreaming ? [] : null,
        writeQueue: Promise.resolve(), // sequential write pipeline
        lastChunkReceived: false
      };
      this.receivingFiles.set(message.fileId, fileInfo);

      if (useStreaming) {
        (async () => {
          let writable;
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: message.name });
            writable = await handle.createWritable();
          } catch (err) {
            console.warn('[BC] Save picker cancelled or failed; falling back to memory mode:', err);
            fileInfo.streaming = false;
            if (fileInfo.pendingChunks) {
              for (let i = 0; i < fileInfo.pendingChunks.length; i++) {
                if (fileInfo.pendingChunks[i]) fileInfo.chunks[i] = fileInfo.pendingChunks[i];
              }
              fileInfo.pendingChunks = null;
            }
            return;
          }

          // Atomically: snapshot pending, enqueue drain, expose writable.
          // No awaits between these statements — chunk handler can't observe a half-set state.
          const pending = fileInfo.pendingChunks || [];
          fileInfo.pendingChunks = null;
          fileInfo.writeQueue = fileInfo.writeQueue.then(async () => {
            for (let i = 0; i < pending.length; i++) {
              if (pending[i]) await writable.write(pending[i]);
            }
          });
          fileInfo.writable = writable;

          // If the last chunk arrived while picker was open, close after drain.
          if (fileInfo.lastChunkReceived) {
            this._finalizeStreamedFile(message.fileId, fileInfo);
          }
        })();
      }

      if (this.onProgressUpdate) {
        this.onProgressUpdate({
          type: 'receiving',
          peerId: message.sender,
          fileName: message.name,
          sender: message.senderInfo || null,
          progress: 0,
          speed: 0,
          timeRemaining: 0
        });
      }
      return;
    }

    if (message.type === 'bc-file-chunk') {
      const fileInfo = this.receivingFiles.get(message.fileId);
      if (!fileInfo) return;

      const bytes = new Uint8Array(message.data);

      if (fileInfo.streaming) {
        if (fileInfo.writable) {
          const w = fileInfo.writable;
          fileInfo.writeQueue = fileInfo.writeQueue
            .then(() => w.write(bytes))
            .catch((err) => { console.error('[BC] Disk write failed:', err); });
        } else if (fileInfo.pendingChunks) {
          fileInfo.pendingChunks[message.index] = bytes;
        } else {
          fileInfo.chunks[message.index] = bytes;
        }
      } else {
        fileInfo.chunks[message.index] = bytes;
      }

      fileInfo.receivedSize += bytes.length;

      const progress = fileInfo.size > 0 ? (fileInfo.receivedSize / fileInfo.size) * 100 : 100;
      if (this.onProgressUpdate) {
        this.onProgressUpdate({
          type: 'receiving',
          peerId: message.sender,
          fileName: fileInfo.name,
          progress: Math.round(progress),
          speed: 0,
          timeRemaining: 0
        });
      }

      if (message.index === message.totalChunks - 1) {
        fileInfo.lastChunkReceived = true;

        if (fileInfo.streaming) {
          // If writable is ready, finalize now (queued behind drain + writes).
          // If not, the picker handler will finalize when it resolves.
          if (fileInfo.writable) {
            this._finalizeStreamedFile(message.fileId, fileInfo);
          }
        } else {
          const blob = new Blob(fileInfo.chunks, { type: fileInfo.type });
          console.log('File received via BroadcastChannel:', fileInfo.name, 'Size:', blob.size);
          if (this.onFileReceived) {
            this.onFileReceived(fileInfo.name, blob, message.sender, {
              sender: fileInfo.sender,
              size: fileInfo.size,
              mimeType: fileInfo.type
            });
          }
          this.receivingFiles.delete(message.fileId);
        }
      }
      return;
    }

    this.handleSignalPayload(message);
  }

  handleSignalPayload(data) {
    if (!data || !data.type) return;
    switch (data.type) {
      case 'online_users':
        this.onlineUsers = data.users.filter(u => u.id !== this.userId);
        if (this.onOnlineUsersChange) {
          this.onOnlineUsersChange(this.onlineUsers);
        }
        break;

      case 'offer':
        this.handleOffer(data.sender, data.offer);
        break;

      case 'answer':
        this.handleAnswer(data.sender, data.answer);
        break;

      case 'ice-candidate':
        this.handleIceCandidate(data.sender, data.candidate);
        break;

      case 'chat_new':
      case 'chat_edit':
      case 'chat_delete':
      case 'chat_react':
      case 'chat_pin':
      case 'chat_mute':
      case 'chat_clear':
      case 'auto_unmuted':
        if (this.onChatEvent) {
          try {
            this.onChatEvent(data);
          } catch (e) {
            console.error('onChatEvent handler failed:', e);
          }
        }
        break;

      case 'file_uploaded':
        if (this.onFileUploaded) {
          try {
            this.onFileUploaded(data);
          } catch (e) {
            console.error('onFileUploaded handler failed:', e);
          }
        }
        break;

      case 'file_deleted':
        if (this.onFileUploaded) {
          try {
            this.onFileUploaded(data);
          } catch (e) {
            console.error('onFileUploaded handler failed:', e);
          }
        }
        break;

      default:
        break;
    }
  }

  sendSignal(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    if (this.broadcastChannel) {
      const clone = { ...payload, sender: this.userId };
      if (clone.candidate && typeof clone.candidate.toJSON === 'function') {
        clone.candidate = clone.candidate.toJSON();
      }
      this.broadcastChannel.postMessage(clone);
      return true;
    }
    return false;
  }

  isSignalingReady() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return true;
    if (this.broadcastChannel) return true;
    return false;
  }

  waitForDataChannelOpen(peerId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const dataChannel = this.dataChannels.get(peerId);
      if (!dataChannel) {
        reject(new Error('Data channel does not exist'));
        return;
      }
      if (dataChannel.readyState === 'open') {
        resolve();
        return;
      }

      const existingOnOpen = dataChannel.onopen;
      const timer = setTimeout(() => {
        dataChannel.onopen = existingOnOpen;
        reject(new Error('Data channel open timeout'));
      }, timeout);

      dataChannel.onopen = () => {
        clearTimeout(timer);
        dataChannel.onopen = existingOnOpen;
        if (existingOnOpen) existingOnOpen();
        resolve();
      };
    });
  }
}

// Export singleton instance
const webrtcManager = new WebRTCManager();
export default webrtcManager;
