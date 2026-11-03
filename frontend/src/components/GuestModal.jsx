import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';

const EMOJIS = ['😀', '😎', '🚀', '🎨', '🎭', '🎪', '🎯', '🎲', '🎸', '🎺', '🎻', '🎮', '🏀', '⚽', '🏈', '🎾', '🎳', '🎰', '🦄', '🐉', '🦖', '🦕', '🐙', '🦀', '🦞', '🦑', '🐠', '🐡', '🦈', '🌟', '✨'];

const GuestModal = ({ isOpen, onClose, onSubmit, error, onClearError }) => {
  const [username, setUsername] = useState('');
  const [selectedEmoji, setSelectedEmoji] = useState('😀');
  const [localError, setLocalError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username.trim()) {
      setLocalError('Please enter a username');
      return;
    }
    onSubmit(username, selectedEmoji);
  };

  const handleUsernameChange = (value) => {
    setUsername(value);
    setLocalError('');
    onClearError && onClearError();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-md w-full p-8 shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
          </button>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Choose Your Identity</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Your Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent text-gray-900 dark:text-white transition"
              placeholder="Enter username"
              maxLength={20}
            />
            {(localError || error) && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">{localError || error}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Pick Your Avatar
            </label>
            <div className="grid grid-cols-8 gap-2">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setSelectedEmoji(emoji)}
                  className={`text-3xl p-2 rounded-lg transition-all hover:scale-110 ${
                    selectedEmoji === emoji
                      ? 'bg-blue-100 dark:bg-blue-900 ring-2 ring-blue-500 scale-110'
                      : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              <strong>Guest Mode:</strong> Guest files are stored on the server for this session only. Create an account to keep them and access them from any device.
            </p>
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors duration-200 shadow-lg hover:shadow-xl"
          >
            Continue as Guest
          </button>
        </form>
      </div>
    </div>
  );
};

export default GuestModal;
