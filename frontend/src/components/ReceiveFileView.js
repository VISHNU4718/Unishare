import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Download, Loader2, FileText, CheckCircle, AlertCircle, Wifi } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import webrtcManager from '../utils/webrtcManager2';
import { isOfflineMode } from '../utils/offline';
import { getBackendUrl } from '../utils/backendUrl';

const formatBytes = (bytes) => {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const guessMimeFromName = (name = '') => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const map = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
        pdf: 'application/pdf',
        txt: 'text/plain', json: 'application/json', js: 'application/javascript',
        md: 'text/markdown', csv: 'text/csv', html: 'text/html'
    };
    return map[ext] || '';
};

const ReceiveFileView = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const { user, loginAsGuest } = useAuth();
    const [status, setStatus] = useState('idle');
    const [error, setError] = useState(null);
    const [progress, setProgress] = useState(0);
    const [fileInfo, setFileInfo] = useState(null);
    const [sender, setSender] = useState(null);
    const [receivedBlob, setReceivedBlob] = useState(null);
    const [receivedMimeType, setReceivedMimeType] = useState('');
    const [textContent, setTextContent] = useState(null);

    const searchParams = new URLSearchParams(location.search);
    const peerId = searchParams.get('peer');
    const fileId = searchParams.get('file');
    const fileName = searchParams.get('name') || 'Unknown File';
    const fileSize = searchParams.get('size');
    const senderName = searchParams.get('from') || 'Someone';
    const senderEmoji = searchParams.get('emoji') || '👤';
    const thumb = searchParams.get('thumb') || '';

    const previewMimeType = guessMimeFromName(fileName);
    const isImage = previewMimeType.startsWith('image/');
    const isVideo = previewMimeType.startsWith('video/');
    const isAudio = previewMimeType.startsWith('audio/');
    const isPDF = previewMimeType === 'application/pdf';
    const isText = previewMimeType.startsWith('text/') || previewMimeType === 'application/json' || previewMimeType === 'application/javascript';

    const blobUrl = useMemo(() => {
        if (!receivedBlob) return null;
        return URL.createObjectURL(receivedBlob);
    }, [receivedBlob]);

    useEffect(() => {
        return () => {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        };
    }, [blobUrl]);

    useEffect(() => {
        if (!peerId || !fileId) {
            setError('Invalid link. Missing peer or file information.');
            setStatus('error');
        }
    }, [peerId, fileId]);

    const mimeType = receivedMimeType || previewMimeType || '';

    useEffect(() => {
        if (isText && receivedBlob && textContent === null) {
            receivedBlob.text().then(setTextContent).catch(() => setTextContent('(failed to load text)'));
        }
    }, [isText, receivedBlob, textContent]);

    const handleDownload = async () => {
        try {
            setStatus('connecting');
            setError(null);

            let currentUser = user;
            if (!currentUser) {
                const result = await loginAsGuest(`Guest_${Math.floor(Math.random() * 1000)}`, '👤');
                if (!result.success) throw new Error(result.error);
                currentUser = result.user;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!webrtcManager.userId && currentUser) {
                webrtcManager.connect(currentUser.id, getBackendUrl(), currentUser.username, currentUser.emoji);
            }

            if (!webrtcManager.isSignalingReady()) {
                let attempts = 0;
                while (!webrtcManager.isSignalingReady() && attempts < 10) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    attempts++;
                }
                if (!webrtcManager.isSignalingReady()) {
                    if (isOfflineMode()) {
                        throw new Error('Offline mode: signaling not ready. Reload both tabs and try again.');
                    }
                    throw new Error('Could not connect to signaling server.');
                }
            }

            setStatus('connecting_peer');
            const dc = webrtcManager.dataChannels.get(peerId);
            if (!dc || dc.readyState !== 'open') {
                if (!dc) await webrtcManager.initiateConnection(peerId);
                await webrtcManager.waitForDataChannelOpen(peerId, 10000);
            }

            setStatus('requesting');
            webrtcManager.onProgressUpdate = (update) => {
                if (!update) return;
                if (update.type === 'receiving') {
                    setStatus('receiving');
                    setProgress(update.progress);
                    setFileInfo({ name: update.fileName });
                    if (update.sender) setSender(update.sender);
                }
            };

            webrtcManager.onFileReceived = (name, blob, _peerId, metadata) => {
                setStatus('completed');
                setReceivedBlob(blob);
                setReceivedMimeType(metadata?.mimeType || blob.type || '');
                if (metadata?.sender) setSender(metadata.sender);
            };

            await webrtcManager.requestFile(peerId, fileId);
        } catch (err) {
            console.error(err);
            setError(err.message || 'Download failed');
            setStatus('error');
        }
    };

    const handleSave = () => {
        if (!blobUrl) return;
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileInfo?.name || fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    if (status === 'completed' && receivedBlob) {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-slate-900 p-4">
                <div className="max-w-5xl mx-auto">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl overflow-hidden">
                        <div className="p-5 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between gap-3">
                            <div className="flex items-center space-x-3 min-w-0">
                                <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg flex-shrink-0">
                                    <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
                                </div>
                                <div className="min-w-0">
                                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                                        {fileInfo?.name || fileName}
                                    </h2>
                                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500 dark:text-gray-400">
                                        <span>{formatBytes(receivedBlob.size)}</span>
                                        {mimeType && <><span>•</span><span className="truncate">{mimeType}</span></>}
                                        <span>•</span>
                                        <span className="flex items-center space-x-1">
                                            <span>from</span>
                                            <span>{senderEmoji}</span>
                                            <span className="font-medium">{senderName}</span>
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center space-x-2 flex-shrink-0">
                                <button
                                    onClick={handleSave}
                                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium flex items-center space-x-2"
                                >
                                    <Download className="w-4 h-4" />
                                    <span>Save</span>
                                </button>
                                <button
                                    onClick={() => navigate('/')}
                                    className="px-4 py-2 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-slate-700"
                                >
                                    Home
                                </button>
                            </div>
                        </div>

                        <div className="p-6 bg-gray-50 dark:bg-slate-900 min-h-[60vh] flex items-center justify-center">
                            {!mimeType && (
                                <div className="text-center max-w-md">
                                    <FileText className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                                    <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                                        Preview not available
                                    </h3>
                                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                                        This file type cannot be previewed in the browser.
                                    </p>
                                    <button
                                        onClick={handleSave}
                                        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium inline-flex items-center space-x-2"
                                    >
                                        <Download className="w-4 h-4" />
                                        <span>Download File</span>
                                    </button>
                                </div>
                            )}
                            {mimeType.startsWith('image/') && blobUrl && (
                                <img src={blobUrl} alt={fileName} className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-lg" />
                            )}
                            {mimeType.startsWith('video/') && blobUrl && (
                                <video src={blobUrl} controls autoPlay className="max-w-full max-h-[75vh] rounded-lg shadow-lg bg-black">
                                    Your browser does not support the video tag.
                                </video>
                            )}
                            {mimeType.startsWith('audio/') && blobUrl && (
                                <div className="w-full max-w-xl bg-white dark:bg-slate-800 rounded-xl p-6 shadow-lg">
                                    <audio src={blobUrl} controls className="w-full" />
                                </div>
                            )}
                            {mimeType === 'application/pdf' && blobUrl && (
                                <iframe src={blobUrl} title={fileName} className="w-full h-[75vh] rounded-lg shadow-lg bg-white" />
                            )}
                            {(mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/javascript') && (
                                <pre className="w-full max-h-[75vh] overflow-auto bg-white dark:bg-slate-800 p-4 rounded-lg shadow-inner text-sm text-gray-800 dark:text-gray-200 font-mono whitespace-pre-wrap">
                                    {textContent ?? 'Loading...'}
                                </pre>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl max-w-lg w-full p-8 text-center">
                <div className="mb-4 flex justify-center">
                    <div className="p-4 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                        <Wifi className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                    </div>
                </div>

                <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                    Receive File
                </h1>
                <p className="text-gray-500 dark:text-gray-400 mb-4">
                    Direct P2P transfer
                </p>

                <div className="mb-4 flex items-center justify-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
                    <span>From</span>
                    <span className="text-xl">{senderEmoji}</span>
                    <span className="font-medium">{senderName}</span>
                </div>

                <div className="bg-gray-50 dark:bg-slate-700/50 rounded-xl p-4 mb-6 border border-gray-100 dark:border-slate-700">
                    {thumb && (
                        <img src={thumb} alt="Preview" className="w-full h-32 object-contain rounded-lg mb-3" />
                    )}
                    <div className="flex items-center space-x-3 text-left">
                        <FileText className="w-10 h-10 text-gray-400" />
                        <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 dark:text-white truncate">
                                {fileName}
                            </p>
                            {fileSize && (
                                <p className="text-xs text-gray-500">
                                    {formatBytes(parseInt(fileSize))}
                                </p>
                            )}
                        </div>
                    </div>
                    {status === 'receiving' && (
                        <div className="mt-4">
                            <div className="h-2 bg-gray-200 dark:bg-slate-600 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-blue-600 transition-all duration-300"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <p className="text-xs text-right text-gray-500 mt-1">{progress}%</p>
                        </div>
                    )}
                </div>

                {error && (
                    <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 rounded-xl flex items-center space-x-2 text-red-600 dark:text-red-400 text-left">
                        <AlertCircle className="w-5 h-5 flex-shrink-0" />
                        <p className="text-sm">{error}</p>
                    </div>
                )}

                <button
                    onClick={handleDownload}
                    disabled={status !== 'idle' && status !== 'error'}
                    className={`w-full py-3 px-4 rounded-xl font-medium text-white transition-all shadow-lg flex items-center justify-center space-x-2 ${status !== 'idle' && status !== 'error'
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'
                        }`}
                >
                    {status === 'idle' || status === 'error' ? (
                        <>
                            <Download className="w-5 h-5" />
                            <span>Accept & Download</span>
                        </>
                    ) : (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>
                                {status === 'connecting' ? 'Connecting to Server...' :
                                    status === 'connecting_peer' ? 'Connecting to Peer...' :
                                        status === 'requesting' ? 'Requesting File...' :
                                            'Receiving...'}
                            </span>
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default ReceiveFileView;
