import { Power, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface RefreshMenuProps {
  onRefresh: () => void;
  isRefreshing: boolean;
}

export function RefreshMenu({ onRefresh, isRefreshing }: RefreshMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleExit = async () => {
    setIsExiting(true);
    try {
      const response = await fetch('/api/exit');
      if (!response.ok) {
        throw new Error('Failed to exit');
      }
      // If the exit fails, show a message after a delay
      setTimeout(() => {
        setIsExiting(false);
        alert('Restart request sent. The app should restart shortly.');
      }, 2000);
    } catch (_error) {
      setIsExiting(false);
      alert('Failed to restart. Please restart the container manually.');
    }
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={isRefreshing}
        className="p-1 hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Refresh options"
      >
        <RefreshCw
          className={`w-4 h-4 text-gray-400 ${
            isRefreshing ? 'animate-spin' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50 min-w-[180px]">
          <button
            type="button"
            onClick={() => {
              onRefresh();
              setIsOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors first:rounded-t-lg"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Refresh Data</span>
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.reload();
              setIsOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Reload Page</span>
          </button>
          <div className="border-t border-gray-700 my-1" />
          <button
            type="button"
            onClick={() => {
              if (confirm('This will restart the weather app. Continue?')) {
                handleExit();
                setIsOpen(false);
              }
            }}
            disabled={isExiting}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-red-900/20 hover:text-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed last:rounded-b-lg"
          >
            <Power className={`w-4 h-4 ${isExiting ? 'animate-pulse' : ''}`} />
            <span>{isExiting ? 'Restarting...' : 'Restart App'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
