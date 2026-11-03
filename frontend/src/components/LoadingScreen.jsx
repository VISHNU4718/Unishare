import React, { useEffect, useRef, useState } from 'react';
import { Share2, Zap } from 'lucide-react';

/**
 * Loading screen — background particles are provided by a single shared
 * AmbientBackground rendered at the App level so they never reset or lag.
 */

const MESSAGES = [
  'Starting UniShare...',
  'Connecting to the server...',
];

const LoadingScreen = ({ onBeginExit, onFinished, minDuration = 1200 }) => {
  const [progress, setProgress] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);
  const [exiting, setExiting] = useState(false);
  const startRef = useRef(Date.now());
  const beginExitCalled = useRef(false);
  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const raw = (elapsed / minDuration) * 100;
      const eased = raw < 80 ? raw * 0.65 : 80 + (raw - 80) * 0.5;
      setProgress((p) => p + (Math.min(100, eased) - p) * 0.12);
    }, 60);

    const timer = setTimeout(() => {
      setProgress(100);
      setTimeout(() => {
        setExiting(true);
        if (!beginExitCalled.current) {
          beginExitCalled.current = true;
          onBeginExit?.();
        }
      }, 300);
    }, minDuration);

    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [minDuration, onBeginExit]);

  useEffect(() => {
    const interval = setInterval(() => {
      setMsgIdx((i) => (i + 1) % MESSAGES.length);
    }, 1200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(onFinished, 700);
    return () => clearTimeout(t);
  }, [exiting, onFinished]);

  const pct = Math.min(100, Math.max(0, Math.floor(progress)));

  return (
    <div
      className={`dark fixed inset-0 z-[100] overflow-hidden text-white transition-[opacity,transform] ${
        exiting ? 'opacity-0 scale-105' : 'opacity-100 scale-100'
      }`}
      style={{
        transitionDuration: '700ms',
        transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Background (gradient + grid + vignette + particles) is provided by the shared AmbientBackground at the App level */}

      <div className="relative min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full">
          {/* Logo */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center mb-7">
              <div className="relative">
                <div className="absolute inset-0 bg-blue-500/40 blur-2xl rounded-full" />
                <div className="relative w-28 h-28 rounded-3xl bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 shadow-2xl flex items-center justify-center ring-1 ring-white/20 animate-logoPulse">
                  <Share2 className="w-14 h-14 text-white drop-shadow" />
                </div>
                <Zap className="w-7 h-7 text-yellow-300 absolute -top-1.5 -right-1.5 drop-shadow animate-zip" />
              </div>
            </div>

            <h1 className="text-6xl md:text-7xl font-extrabold tracking-tight mb-4 leading-[0.95]">
              <span className="bg-gradient-to-r from-blue-300 via-indigo-200 to-purple-300 bg-clip-text text-transparent">
                UniShare
              </span>
            </h1>

            <p className="text-lg text-slate-200/80 font-light">
              Preparing your workspace&hellip;
            </p>
          </div>

          {/* Progress bar */}
          <div className="mb-6">
            <div className="h-2 rounded-2xl bg-slate-800/70 border border-white/10 overflow-hidden shadow-inner">
              <div
                className="h-full rounded-2xl transition-[width] duration-200 ease-out"
                style={{
                  width: `${pct}%`,
                  background: 'linear-gradient(90deg, #3b82f6, #6366f1, #a855f7)',
                  boxShadow: '0 0 30px rgba(99,102,241,0.5), 0 0 60px rgba(99,102,241,0.2)',
                }}
              >
                <div
                  className="h-full w-12 rounded-2xl animate-barShimmer"
                  style={{
                    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Status + percentage */}
          <div className="flex justify-between items-center px-1">
            <p className="text-sm text-slate-400 font-light truncate mr-3">
              {MESSAGES[msgIdx]}
            </p>
            <span className="text-sm font-mono tabular-nums text-indigo-300/80 whitespace-nowrap">
              {pct}%
            </span>
          </div>

          {/* Feature pills */}
          <div className="mt-10 flex items-center justify-center gap-2 text-sm text-slate-300/80 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/60 border border-white/10">
              <span className="text-blue-300"><Zap className="w-3.5 h-3.5" /></span>
              <span className="text-slate-200">P2P WebRTC</span>
            </span>
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/60 border border-white/10">
              <span className="text-blue-300">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
              </span>
              <span className="text-slate-200">Cloud</span>
            </span>
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/60 border border-white/10">
              <span className="text-blue-300">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              </span>
              <span className="text-slate-200">Google Drive</span>
            </span>
          </div>

          <p className="mt-6 text-center text-slate-500 text-[11px] tracking-wider uppercase">
            Secure &middot; Encrypted &middot; Instant
          </p>
        </div>
      </div>

      <style>{`
        @keyframes logoPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        .animate-logoPulse {
          animation: logoPulse 3s ease-in-out infinite;
        }

        @keyframes zip {
          0%, 100% { transform: scale(1) rotate(0deg); }
          50% { transform: scale(1.2) rotate(8deg); }
        }
        .animate-zip { animation: zip 2.4s ease-in-out infinite; }

        @keyframes barShimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
        .animate-barShimmer {
          animation: barShimmer 2s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .animate-logoPulse, .animate-zip, .animate-barShimmer {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
};

export default LoadingScreen;
