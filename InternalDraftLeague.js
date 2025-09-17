/**
 * Reload-Proof Scorekeeping Application
 * Enhanced with comprehensive state persistence
 */

// =====================================================
// CONSTANTS AND CONFIGURATION
// =====================================================
const CONFIG = {

  API_URL: "https://docs.google.com/spreadsheets/d/1mhuN_H1C_DZ26r1NQRf4muQwszSd8F9mCfyWF5Iwjjo/export?format=csv&gid=884172048",
  SUBMIT_URL: "https://script.google.com/macros/s/AKfycbzFIR36V3v_L1OppUTNGBiicJSSCUtO7EUNcLgj3oYoP7k3uIzMLqffAwW_sT2W87fF/exec",
  DEFAULT_TIMER_MINUTES: 100,
  LOADING_ANIMATION_INTERVAL: 500,
  AUTO_SAVE_INTERVAL: 2000, // Auto-save every 2 seconds
  STORAGE_KEYS: {
    SCORE_LOGS: 'scoreLogs',
    TIMER_END_TIME: 'timerEndTime',
    TIMER_RUNNING: 'timerRunning',
    GAME_STATE: 'gameState',
    TEAMS_DATA: 'teamsData',
    LAST_SAVE: 'lastSave'
  }
};

const SPECIAL_OPTIONS = {
  NA: 'N/A',
  CALLAHAN: '‼️CALLAHAN‼️'
};

// =====================================================
// UTILITY FUNCTIONS
// =====================================================
const Utils = {
  /**
   * Safe JSON parse with fallback
   */
  safeJsonParse: (str, fallback = null) => {
    try {
      return JSON.parse(str) || fallback;
    } catch (e) {
      console.warn('JSON parse failed:', e);
      return fallback;
    }
  },

  /**
   * Debounce function to limit rapid function calls
   */
  debounce: (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Show user notification
   */
  showNotification: (message, type = 'info') => {
    if (type === 'error') {
      console.error(message);
      alert(`Error: ${message}`);
    } else {
      console.log(message);
      if (type === 'success') {
        const successEl = document.getElementById('successMessage');
        if (successEl) {
          successEl.textContent = message;
          successEl.style.display = 'block';
          setTimeout(() => {
            successEl.style.display = 'none';
          }, 5000);
        }
      }
    }
  },

  /**
   * Create DOM element with attributes and content
   */
  createElement: (tag, attributes = {}, content = '') => {
    const element = document.createElement(tag);
    Object.entries(attributes).forEach(([key, value]) => {
      element.setAttribute(key, value);
    });
    if (content) element.textContent = content;
    return element;
  },

  /**
   * Generate unique ID
   */
  generateId: () => {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  },

  /**
   * Sanitize a string for safe filenames
   */
  sanitizeFilename: (name, fallback = 'Game') => {
    const base = (name || '').toString().trim() || fallback;
    // Replace invalid filename chars and trim length
    return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 120);
  },

  /**
   * Convert array of fields to a CSV line with proper escaping
   */
  toCSVLine: (fields) => {
    return fields.map((v) => {
      let s = (v === null || v === undefined) ? '' : String(v);
      if (/[",\n\r]/.test(s)) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',');
  },

  /**
   * Download text content as a file on the client
   */
  downloadTextFile: (filename, text, mime = 'text/csv;charset=utf-8;') => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Parse CSV text into array of rows (handles quoted commas)
   */
  parseCSV: (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          cell += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(cell);
        cell = '';
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (cell !== '' || row.length > 0) {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
        }
      } else {
        if (char !== '\r') cell += char; // ignore stray CR
      }
    }

    // push last cell/row if any
    if (cell !== '' || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }

    return rows;
  },

  /**
   * Convert CSV rows (first row team names) to { teamName: [players] }
   */
  csvToTeamsMap: (rows) => {
    if (!rows || rows.length === 0) return {};
    const header = rows[0].map(h => (h || '').trim()).filter(Boolean);
    const teams = {};
    header.forEach((teamName, colIdx) => {
      const players = [];
      for (let r = 1; r < rows.length; r++) {
        const val = (rows[r][colIdx] || '').trim();
        if (val) players.push(val);
      }
      teams[teamName] = players;
    });
    return teams;
  }
};

// =====================================================
// PERSISTENCE MANAGER - Handles all data persistence
// =====================================================
class PersistenceManager {
  constructor() {
    this.autoSaveInterval = null;
    this.lastSaveTime = 0;
  }

  /**
   * Save data to localStorage with error handling
   */
  saveToStorage(key, data) {
    try {
      const serializedData = JSON.stringify(data);
      localStorage.setItem(key, serializedData);
      this.lastSaveTime = Date.now();
      localStorage.setItem(CONFIG.STORAGE_KEYS.LAST_SAVE, this.lastSaveTime.toString());
      return true;
    } catch (error) {
      console.error(`Failed to save ${key}:`, error);
      // Try to free up space by removing old data
      this.cleanupOldData();
      try {
        const serializedData = JSON.stringify(data);
        localStorage.setItem(key, serializedData);
        return true;
      } catch (retryError) {
        console.error(`Retry failed for ${key}:`, retryError);
        return false;
      }
    }
  }

  /**
   * Load data from localStorage
   */
  loadFromStorage(key, fallback = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : fallback;
    } catch (error) {
      console.error(`Failed to load ${key}:`, error);
      return fallback;
    }
  }

  /**
   * Save complete game state
   */
  saveGameState(gameState) {
    return this.saveToStorage(CONFIG.STORAGE_KEYS.GAME_STATE, {
      ...gameState,
      timestamp: Date.now()
    });
  }

  /**
   * Load complete game state
   */
  loadGameState() {
    const defaultState = {
      teamAScore: 0,
      teamBScore: 0,
      teamAName: '',
      teamBName: '',
      teamAPlayers: '',
      teamBPlayers: '',
      gameTime: '',
      scoreLogs: [],
      timestamp: Date.now()
    };

    return this.loadFromStorage(CONFIG.STORAGE_KEYS.GAME_STATE, defaultState);
  }

  /**
   * Save teams data with expiration
   */
  saveTeamsData(teamsData) {
    const dataWithExpiry = {
      data: teamsData,
      timestamp: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };
    return this.saveToStorage(CONFIG.STORAGE_KEYS.TEAMS_DATA, dataWithExpiry);
  }

  /**
   * Load teams data (check expiration)
   */
  loadTeamsData() {
    const storedData = this.loadFromStorage(CONFIG.STORAGE_KEYS.TEAMS_DATA);
    
    if (!storedData) return null;
    
    // Check if data has expired
    if (Date.now() > storedData.expiresAt) {
      localStorage.removeItem(CONFIG.STORAGE_KEYS.TEAMS_DATA);
      return null;
    }
    
    return storedData.data;
  }

  /**
   * Start auto-save functionality
   */
  startAutoSave(saveCallback) {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }

    this.autoSaveInterval = setInterval(() => {
      if (typeof saveCallback === 'function') {
        saveCallback();
      }
    }, CONFIG.AUTO_SAVE_INTERVAL);
  }

  /**
   * Stop auto-save
   */
  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }

  /**
   * Clean up old data to free space
   */
  cleanupOldData() {
    try {
      // Remove expired teams data
      const teamsData = this.loadFromStorage(CONFIG.STORAGE_KEYS.TEAMS_DATA);
      if (teamsData && Date.now() > teamsData.expiresAt) {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.TEAMS_DATA);
      }

      // Remove very old game states (older than 7 days)
      const gameState = this.loadFromStorage(CONFIG.STORAGE_KEYS.GAME_STATE);
      if (gameState && gameState.timestamp && (Date.now() - gameState.timestamp) > (7 * 24 * 60 * 60 * 1000)) {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.GAME_STATE);
      }
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  }

  /**
   * Get storage usage info
   */
  getStorageInfo() {
    let totalSize = 0;
    let itemCount = 0;

    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        totalSize += localStorage[key].length;
        itemCount++;
      }
    }

    return {
      totalSize: totalSize,
      itemCount: itemCount,
      lastSave: this.loadFromStorage(CONFIG.STORAGE_KEYS.LAST_SAVE)
    };
  }

  /**
   * Clear all app data
   */
  clearAllData() {
    Object.values(CONFIG.STORAGE_KEYS).forEach(key => {
      localStorage.removeItem(key);
    });
    sessionStorage.clear();
  }
}

// =====================================================
// DATA MANAGER - Enhanced with persistence
// =====================================================
class DataManager {
  constructor(persistenceManager) {
    this.persistenceManager = persistenceManager;
    this.teamsData = {};
    this.scoreLogs = [];
    this.gameState = {};
    this.isDirty = false; // Track if data needs saving
    
    this.loadAllData();
  }

  /**
   * Load all persisted data
   */
  loadAllData() {
    // Load game state
    this.gameState = this.persistenceManager.loadGameState();
    this.scoreLogs = this.gameState.scoreLogs || [];
    
    // Load teams data
    const cachedTeamsData = this.persistenceManager.loadTeamsData();
    if (cachedTeamsData) {
      this.teamsData = cachedTeamsData;
    }
  }

  /**
   * Save current state
   */
  saveCurrentState() {
    if (!this.isDirty) return;

    const success = this.persistenceManager.saveGameState(this.gameState);
    if (success) {
      this.isDirty = false;
    }
    return success;
  }

  /**
   * Mark data as dirty (needs saving)
   */
  markDirty() {
    this.isDirty = true;
  }

  /**
   * Update game state
   */
  updateGameState(updates) {
    Object.assign(this.gameState, updates);
    this.markDirty();
  }

  /**
   * Add new score log
   */
  addScoreLog(logEntry) {
    this.scoreLogs.push(logEntry);
    this.gameState.scoreLogs = this.scoreLogs;
    this.markDirty();
  }

  /**
   * Update existing score log
   */
  updateScoreLog(scoreID, updates) {
    const index = this.scoreLogs.findIndex(log => log.scoreID === scoreID);
    if (index !== -1) {
      Object.assign(this.scoreLogs[index], updates);
      this.gameState.scoreLogs = this.scoreLogs;
      this.markDirty();
      return true;
    }
    return false;
  }

  /**
   * Get score log by ID
   */
  getScoreLog(scoreID) {
    return this.scoreLogs.find(log => log.scoreID === scoreID);
  }

  /**
   * Clear all score logs
   */
  clearScoreLogs() {
    this.scoreLogs = [];
    this.gameState.scoreLogs = [];
    this.markDirty();
  }

  /**
   * Get teams data
   */
  getTeamsData() {
    return this.teamsData;
  }

  /**
   * Set teams data
   */
  setTeamsData(data) {
    this.teamsData = data || {};
    this.persistenceManager.saveTeamsData(this.teamsData);
  }

  /**
   * Remove a score log by ID
   */
  removeScoreLog(scoreID) {
    const index = this.scoreLogs.findIndex(log => log.scoreID === scoreID);
    if (index === -1) return null;
    const [removed] = this.scoreLogs.splice(index, 1);
    this.gameState.scoreLogs = this.scoreLogs;
    this.markDirty();
    return removed;
  }

  /**
   * Get current game state
   */
  getGameState() {
    return this.gameState;
  }

  /**
   * Reset game state
   */
  resetGameState() {
    this.gameState = {
      teamAScore: 0,
      teamBScore: 0,
      teamAName: '',
      teamBName: '',
      teamAPlayers: '',
      teamBPlayers: '',
      gameTime: '',
      scoreLogs: [],
      timestamp: Date.now()
    };
    this.scoreLogs = [];
    this.markDirty();
  }
}

// =====================================================
// API MANAGER - Same as before
// =====================================================
class ApiManager {
  constructor() {
    this.teamsUrl = CONFIG.API_URL;
    this.submitUrl = CONFIG.SUBMIT_URL;
  }

  async fetchTeams() {
    try {
      const response = await fetch(this.teamsUrl, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      // Try to parse as JSON first in case API_URL points to JSON
      const contentType = response.headers.get('Content-Type') || '';
      const isLikelyJson = contentType.includes('application/json') || this.teamsUrl.endsWith('.json');

      if (isLikelyJson) {
        const data = await response.json();
        return data || {};
      }

      // Otherwise parse CSV into { teamName: [players] }
      const text = await response.text();
      const rows = Utils.parseCSV(text);
      const teams = Utils.csvToTeamsMap(rows);
      return teams;
    } catch (error) {
      console.error("Error fetching teams:", error);
      throw new Error(`Failed to fetch teams: ${error.message}`);
    }
  }

  async submitScores(dataToSend) {
    try {
      if (!this.submitUrl) {
        console.warn('SUBMIT_URL is not configured; skipping export.');
        return false;
      }

      const response = await fetch(this.submitUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dataToSend)
      });

      // With no-cors we can't read response; assume success
      return true;
    } catch (error) {
      console.error("Error submitting scores:", error);
      throw new Error(`Failed to submit scores: ${error.message}`);
    }
  }
}

// =====================================================
// REVAMPED TIMER MANAGER - Simple countdown from future date
// =====================================================
class TimerManager {
  constructor(persistenceManager) {
    this.persistenceManager = persistenceManager;
    this.timerInterval = null;
    this.isRunning = false;
    this.endTime = null;
    this.remainingTimeMs = null; // Store remaining time when paused
    this.defaultMinutes = CONFIG.DEFAULT_TIMER_MINUTES;
    
    this.loadTimerState();
  }


  /**
   * Get time remaining until endTime
   */
  getTimeRemaining(endtime) {
    const total = Date.parse(endtime) - Date.parse(new Date());
    const seconds = Math.floor((total / 1000) % 60);
    const minutes = Math.floor(total / 1000 / 60);
    
    return {
      total,
      minutes,
      seconds
    };
  }

  /**
   * Load saved timer state
   */
  loadTimerState() {
    const storedEndTime = this.persistenceManager.loadFromStorage('timerEndTime');
    const storedIsRunning = this.persistenceManager.loadFromStorage(CONFIG.STORAGE_KEYS.TIMER_RUNNING);
    const storedRemainingTime = this.persistenceManager.loadFromStorage('timerRemainingTime');

    if (storedEndTime) {
      this.endTime = new Date(storedEndTime);
    }

    if (storedRemainingTime) {
      this.remainingTimeMs = parseInt(storedRemainingTime, 10);
    }

    this.isRunning = (storedIsRunning === true || storedIsRunning === 'true');

    // Check if timer should still be running
    if (this.isRunning && this.endTime) {
      const timeRemaining = this.getTimeRemaining(this.endTime);
      if (timeRemaining.total <= 0) {
        // Timer expired while away
        this.stop();
        this.updateDisplay();
      } else {
        // Resume timer
        this.start();
      }
    } else if (this.remainingTimeMs !== null) {
      // Timer was paused, restore remaining time
      this.setRemainingTime(this.remainingTimeMs);
      this.updateDisplay();
    } else {
      // Initialize with default time if no saved state
      this.reset(this.defaultMinutes);
    }
  }

  /**
   * Save timer state to storage
   */
  saveTimerState() {
    this.persistenceManager.saveToStorage('timerEndTime', this.endTime ? this.endTime.toISOString() : null);
    this.persistenceManager.saveToStorage(CONFIG.STORAGE_KEYS.TIMER_RUNNING, this.isRunning);
    this.persistenceManager.saveToStorage('timerRemainingTime', this.remainingTimeMs);
  }

  /**
   * Set remaining time from milliseconds
   */
  setRemainingTime(milliseconds) {
    this.remainingTimeMs = milliseconds;
    // Set endTime to null when paused to indicate we're using remainingTimeMs
    this.endTime = null;
  }

  /**
   * Update the timer display
   */
  updateDisplay() {
    const timerDisplay = document.getElementById('timerDisplay');
    
    if (!timerDisplay) return;

    let timeRemaining;
    
    if (this.isRunning && this.endTime) {
      // Timer is running, calculate from endTime
      timeRemaining = this.getTimeRemaining(this.endTime);
    } else if (this.remainingTimeMs !== null) {
      // Timer is paused, use stored remaining time
      const total = this.remainingTimeMs;
      const seconds = Math.floor((total / 1000) % 60);
      const minutes = Math.floor(total / 1000 / 60);
      timeRemaining = { total, minutes, seconds };
    } else {
      // Fallback to default time
      const total = this.defaultMinutes * 60 * 1000;
      const seconds = 0;
      const minutes = this.defaultMinutes;
      timeRemaining = { total, minutes, seconds };
    }

    const absMinutes = Math.abs(timeRemaining.minutes);
    const absSeconds = Math.abs(timeRemaining.seconds);
    
    const mins = absMinutes.toString().padStart(2, '0');
    const secs = absSeconds.toString().padStart(2, '0');

    let timeString = `${mins}:${secs}`;

    if (timeRemaining.total < 0) {
      timeString = `-${timeString}`;
      timerDisplay.classList.add('timer-negative');
    } else {
      timerDisplay.classList.remove('timer-negative');
    }

    timerDisplay.textContent = timeString;
    
    // Update game time field if it exists
    const timeInput = document.getElementById('time');
    if (timeInput) {
      timeInput.value = new Date().toLocaleString();
    }
  }

  /**
   * Start the timer
   */
  start() {
    if (this.isRunning) return;
    
    // If we have remaining time (from pause), set new end time based on it
    if (this.remainingTimeMs !== null) {
      this.endTime = new Date(Date.now() + this.remainingTimeMs);
      this.remainingTimeMs = null; // Clear since we're now running
    }
    
    // If we still don't have an end time, set default
    if (!this.endTime) {
      this.endTime = new Date(Date.now() + (this.defaultMinutes * 60 * 1000));
    }
    
    this.isRunning = true;
    this.updateUI();
    this.saveTimerState();

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(() => {
      this.updateDisplay();
      
      const timeRemaining = this.getTimeRemaining(this.endTime);
      if (timeRemaining.total <= 0 && this.isRunning) {
        this.stop();
      }
    }, 1000);

    // Initial update
    this.updateDisplay();
  }

  /**
   * Stop/Pause the timer
   */
  stop() {
    if (!this.isRunning) return;
    
    // Store remaining time when pausing
    if (this.endTime) {
      const timeRemaining = this.getTimeRemaining(this.endTime);
      this.remainingTimeMs = Math.max(0, timeRemaining.total); // Don't store negative time
    }
    
    this.isRunning = false;
    this.endTime = null; // Clear endTime when paused
    
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    
    this.updateUI();
    this.saveTimerState();
    this.updateDisplay(); // Update display to show paused time
  }

  /**
   * Toggle timer play/pause
   */
  toggle() {
    if (this.isRunning) {
      this.stop();
    } else {
      this.start();
    }
  }

  /**
   * Reset timer to specified minutes
   */
  reset(minutes = this.defaultMinutes) {
    this.stop();
    
    // Set remaining time and clear endTime
    this.remainingTimeMs = minutes * 60 * 1000;
    this.endTime = null;
    
    this.saveTimerState();
    this.updateDisplay();
    this.updateUI();
  }

  /**
   * Update UI elements
   */
  updateUI() {
    const playPauseBtn = document.getElementById('playPauseBtn');
    const timerColumn = document.getElementById('timerColumn');
    
    if (playPauseBtn) {
      playPauseBtn.textContent = this.isRunning ? "Pause" : "Play";
    }
    
    if (timerColumn) {
      timerColumn.classList.toggle('timer-running', this.isRunning);
      timerColumn.classList.toggle('timer-paused', !this.isRunning);
    }
  }

  /**
   * Get remaining time in seconds (for debugging/external use)
   */
  getRemainingSeconds() {
    if (this.isRunning && this.endTime) {
      const timeRemaining = this.getTimeRemaining(this.endTime);
      return Math.floor(timeRemaining.total / 1000);
    } else if (this.remainingTimeMs !== null) {
      return Math.floor(this.remainingTimeMs / 1000);
    }
    return 0;
  }
}

// =====================================================
// SECONDS TIMER MANAGER - Simple second-based countdown
// =====================================================
class SecondsTimerManager {
  constructor() {
    this.timerInterval = null;
    this.isRunning = false;
    this.endTime = null;
    this.remainingTimeMs = null;
    this.defaultSeconds = 90;
    this.updateDisplay();
  }

  // Start countdown using current remaining or default
  start() {
    if (this.isRunning) return;
    if (this.remainingTimeMs === null) {
      const secondsInput = document.getElementById('countdownTimeSec');
      const secs = parseInt(secondsInput?.value, 10) || this.defaultSeconds;
      this.remainingTimeMs = secs * 1000;
    }
    this.endTime = new Date(Date.now() + this.remainingTimeMs);
    this.isRunning = true;
    this.timerInterval = setInterval(() => this.tick(), 200);
    this.updateUI();
  }

  // Stop countdown and keep remaining time
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = null;
    const timeRemaining = this.getTimeRemaining(this.endTime);
    this.remainingTimeMs = Math.max(0, timeRemaining.total);
    this.endTime = null;
    this.updateUI();
  }

  toggle() { this.isRunning ? this.stop() : this.start(); }

  reset(seconds = this.defaultSeconds) {
    this.stop();
    const secs = Math.max(1, parseInt(seconds, 10) || this.defaultSeconds);
    this.remainingTimeMs = secs * 1000;
    this.updateDisplay();
  }

  getTimeRemaining(endtime) {
    const total = Date.parse(endtime) - Date.parse(new Date());
    const seconds = Math.floor((total / 1000) % 60);
    const minutes = Math.floor(total / 1000 / 60);
    return { total, minutes, seconds };
  }

  tick() {
    const timeRemaining = this.getTimeRemaining(this.endTime);
    this.updateDisplay(timeRemaining);
    if (timeRemaining.total <= 0) {
      this.stop();
      this.remainingTimeMs = 0;
    }
  }

  updateUI() {
    const playPauseBtn = document.getElementById('playPauseSecBtn');
    const timerColumn = document.getElementById('timerColumnSec');
    if (playPauseBtn) playPauseBtn.textContent = this.isRunning ? 'Pause' : 'Play';
    if (timerColumn) {
      timerColumn.classList.toggle('timer-running', this.isRunning);
      timerColumn.classList.toggle('timer-paused', !this.isRunning);
    }
  }

  updateDisplay(existing) {
    const timerDisplay = document.getElementById('timerDisplaySec');
    if (!timerDisplay) return;

    let timeRemaining = existing;
    if (!timeRemaining) {
      if (this.isRunning && this.endTime) {
        timeRemaining = this.getTimeRemaining(this.endTime);
      } else if (this.remainingTimeMs !== null) {
        const total = this.remainingTimeMs;
        const seconds = Math.floor((total / 1000) % 60);
        const minutes = Math.floor(total / 1000 / 60);
        timeRemaining = { total, minutes, seconds };
      } else {
        const total = this.defaultSeconds * 1000;
        const minutes = Math.floor(this.defaultSeconds / 60);
        const seconds = this.defaultSeconds % 60;
        timeRemaining = { total, minutes, seconds };
      }
    }

    const mins = Math.max(0, timeRemaining.minutes).toString().padStart(2, '0');
    const secs = Math.max(0, timeRemaining.seconds).toString().padStart(2, '0');
    timerDisplay.textContent = `${mins}:${secs}`;
  }
}

// =====================================================
// LOADING MANAGER - Same as before
// =====================================================
class LoadingManager {
  constructor() {
    this.loadingInterval = null;
  }

  start() {
    const loadingAnimation = document.getElementById('loadingAnimation');
    const dots = document.getElementById('dots');
    
    if (!loadingAnimation || !dots) return;

    let dotCount = 0;
    loadingAnimation.style.display = 'block';
    
    this.loadingInterval = setInterval(() => {
      dotCount = (dotCount + 1) % 4;
      dots.textContent = '.'.repeat(dotCount);
    }, CONFIG.LOADING_ANIMATION_INTERVAL);
  }

  stop() {
    const loadingAnimation = document.getElementById('loadingAnimation');
    const dots = document.getElementById('dots');
    
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
    
    if (loadingAnimation) loadingAnimation.style.display = 'none';
    if (dots) dots.textContent = '';
  }
}

// =====================================================
// MAIN APPLICATION CLASS - Enhanced with state restoration
// =====================================================
class ScorekeeperApp {
  constructor() {
    // Initialize managers
    this.persistenceManager = new PersistenceManager();
    this.dataManager = new DataManager(this.persistenceManager);
    this.apiManager = new ApiManager();
    this.loadingManager = new LoadingManager();
    this.timerManager = new TimerManager(this.persistenceManager);
    this.secondsTimer = new SecondsTimerManager();
    
    // Application state
    this.teamAScore = 0;
    this.teamBScore = 0;
    this.currentEditID = null;
    this.isRestoring = false;
    this.abbaStart = 'M';
    
    // Bind methods
    this.handleTeamChange = this.handleTeamChange.bind(this);
    this.handleSaveScore = this.handleSaveScore.bind(this);
    this.handleSubmitScore = this.handleSubmitScore.bind(this);
    this.handleDeleteScore = this.handleDeleteScore.bind(this);
    this.handleTimerToggle = this.handleTimerToggle.bind(this);
    this.handleTimerReset = this.handleTimerReset.bind(this);
    this.handleSecTimerToggle = this.handleSecTimerToggle.bind(this);
    this.handleSecTimerReset = this.handleSecTimerReset.bind(this);
    this.openPopup = this.openPopup.bind(this);
    this.closePopup = this.closePopup.bind(this);
    this.autoSave = this.autoSave.bind(this);
    this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
    this.handleAbbaChange = this.handleAbbaChange.bind(this);
  }

  /**
   * Initialize the application with state restoration
   */
  async init() {
    try {
      // Set up before unload handler
      window.addEventListener('beforeunload', this.handleBeforeUnload);
      
      // Start auto-save
      this.persistenceManager.startAutoSave(this.autoSave);
      
      // Check if we need to restore state
      await this.checkAndRestoreState();
      
      // Load teams data (from cache or API)
      await this.loadTeams();

      // Initialize ABBA selector
      const abbaSelect = document.getElementById('abbaStart');
      if (abbaSelect) {
        abbaSelect.value = this.abbaStart;
        abbaSelect.addEventListener('change', this.handleAbbaChange);
      }
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Set up page visibility handler for mobile
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.autoSave();
        }
      });
      
      Utils.showNotification('Application initialized successfully', 'success');
    } catch (error) {
      Utils.showNotification(`Failed to initialize application: ${error.message}`, 'error');
    }
  }

  /**
   * Check and restore previous state
   */
  async checkAndRestoreState() {
    const gameState = this.dataManager.getGameState();
    
    // If we have a recent state (less than 24 hours old), restore it
    if (gameState.timestamp && (Date.now() - gameState.timestamp) < (24 * 60 * 60 * 1000)) {
      this.isRestoring = true;
      
      // Show restore notification
      const shouldRestore = confirm(
        'Previous game data found. Would you like to restore your previous session?'
      );
      
      if (shouldRestore) {
        await this.restoreGameState(gameState);
        Utils.showNotification('Previous session restored successfully', 'success');
      } else {
        this.dataManager.resetGameState();
      }
      
      this.isRestoring = false;
    }
  }

  /**
   * Restore complete game state
   */
  async restoreGameState(gameState) {
    // Restore scores
    this.teamAScore = gameState.teamAScore || 0;
    this.teamBScore = gameState.teamBScore || 0;
    
    // Restore team selections
    const teamASelect = document.getElementById('teamA');
    const teamBSelect = document.getElementById('teamB');
    
    if (teamASelect && gameState.teamAName) {
      teamASelect.value = gameState.teamAName;
    }
    if (teamBSelect && gameState.teamBName) {
      teamBSelect.value = gameState.teamBName;
    }
    
    // Restore player lists
    const teamAList = document.getElementById('teamAList');
    const teamBList = document.getElementById('teamBList');
    
    if (teamAList && gameState.teamAPlayers) {
      teamAList.value = gameState.teamAPlayers;
    }
    if (teamBList && gameState.teamBPlayers) {
      teamBList.value = gameState.teamBPlayers;
    }
    
    // Restore game time
    const timeInput = document.getElementById('time');
    if (timeInput && gameState.gameTime) {
      timeInput.value = gameState.gameTime;
    }
    
    // Restore score logs and rebuild table
    if (gameState.scoreLogs && gameState.scoreLogs.length > 0) {
      this.rebuildScoreTable(gameState.scoreLogs);
    }

    // Restore ABBA start if present
    const abbaSelect = document.getElementById('abbaStart');
    if (abbaSelect && gameState.abbaStart) {
      this.abbaStart = gameState.abbaStart === 'F' ? 'F' : 'M';
      abbaSelect.value = this.abbaStart;
      this.updateAbbaColumn();
    }
  }

  /**
   * Rebuild score table from logs
   */
  rebuildScoreTable(scoreLogs) {
    const scoringTableBody = document.getElementById('scoringTableBody');
    if (!scoringTableBody) return;
    
    // Clear existing rows
    scoringTableBody.innerHTML = '';
    
    // Add each score log to table
    scoreLogs.forEach((logEntry, idx) => {
      const row = this.createScoreRow(logEntry, idx);
      scoringTableBody.appendChild(row);
    });
  }

  /**
   * Auto-save current state
   */
  autoSave() {
    if (this.isRestoring) return;
    
    // Capture current UI state
    const currentState = {
      teamAScore: this.teamAScore,
      teamBScore: this.teamBScore,
      teamAName: document.getElementById('teamA')?.value || '',
      teamBName: document.getElementById('teamB')?.value || '',
      teamAPlayers: document.getElementById('teamAList')?.value || '',
      teamBPlayers: document.getElementById('teamBList')?.value || '',
      gameTime: document.getElementById('time')?.value || '',
      scoreLogs: this.dataManager.scoreLogs,
      abbaStart: document.getElementById('abbaStart')?.value || this.abbaStart,
      timestamp: Date.now()
    };
    
    this.dataManager.updateGameState(currentState);
    this.dataManager.saveCurrentState();
  }

  /**
   * Handle before page unload
   */
  handleBeforeUnload(event) {
    // Perform final save
    this.autoSave();
    
    // If there's unsaved data, show warning
    if (this.dataManager.isDirty || this.dataManager.scoreLogs.length > 0) {
      const message = 'You have unsaved game data. Are you sure you want to leave?';
      event.returnValue = message;
      return message;
    }
  }

  /**
   * Load teams from API or cache
   */
  async loadTeams() {
    try {
      // Always fetch latest from API on launch
      await this.loadTeamsFromAPI();
    } catch (error) {
      console.warn('Primary team loading failed, attempting cache:', error);
      // Fallback to cached teams if available
      const cachedTeams = this.dataManager.getTeamsData();
      if (cachedTeams && Object.keys(cachedTeams).length > 0) {
        this.populateTeamOptions(cachedTeams);
        Utils.showNotification('Using cached team list due to network error.', 'info');
      } else {
        Utils.showNotification(`Failed to load teams: ${error.message}`, 'error');
        this.dataManager.setTeamsData({});
      }
    }
  }

  /**
   * Load teams from API
   */
  async loadTeamsFromAPI() {
    const teamsData = await this.apiManager.fetchTeams();
    this.dataManager.setTeamsData(teamsData);
    this.populateTeamOptions(teamsData);
  }

  /**
   * Populate team selection dropdowns
   */
  populateTeamOptions(teams) {
    const teamASelect = document.getElementById('teamA');
    const teamBSelect = document.getElementById('teamB');
    
    if (!teamASelect || !teamBSelect) return;

    // Store current selections
    const currentTeamA = teamASelect.value;
    const currentTeamB = teamBSelect.value;

    // Clear existing options except the first one
    teamASelect.innerHTML = '<option value="">Select Team A</option>';
    teamBSelect.innerHTML = '<option value="">Select Team B</option>';

    const teamNames = Object.keys(teams);
    
    // Create options for both selects
    teamNames.forEach(teamName => {
      const optionA = Utils.createElement('option', { value: teamName }, teamName);
      const optionB = Utils.createElement('option', { value: teamName }, teamName);
      
      teamASelect.appendChild(optionA);
      teamBSelect.appendChild(optionB);
    });

    // Restore previous selections
    if (currentTeamA) teamASelect.value = currentTeamA;
    if (currentTeamB) teamBSelect.value = currentTeamB;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Team selection change handlers
    const teamASelect = document.getElementById('teamA');
    const teamBSelect = document.getElementById('teamB');
    
    if (teamASelect) {
      teamASelect.addEventListener('change', () => {
        this.handleTeamChange('teamA');
        this.autoSave();
      });
    }
    if (teamBSelect) {
      teamBSelect.addEventListener('change', () => {
        this.handleTeamChange('teamB');
        this.autoSave();
      });
    }

    // Auto-save on input changes
    const autoSaveInputs = ['teamAList', 'teamBList', 'time'];
    autoSaveInputs.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('input', Utils.debounce(this.autoSave, 1000));
      }
    });

    // Timer controls
    const playPauseBtn = document.getElementById('playPauseBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', this.handleTimerToggle);
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', this.handleTimerReset);
    }

    // Seconds timer controls
    const playPauseSecBtn = document.getElementById('playPauseSecBtn');
    const resetSecBtn = document.getElementById('resetSecBtn');
    if (playPauseSecBtn) {
      playPauseSecBtn.addEventListener('click', this.handleSecTimerToggle);
    }
    if (resetSecBtn) {
      resetSecBtn.addEventListener('click', this.handleSecTimerReset);
    }

    // Score buttons
    const addScoreTeamA = document.getElementById('addScoreTeamA');
    const addScoreTeamB = document.getElementById('addScoreTeamB');
    
    if (addScoreTeamA) {
      addScoreTeamA.addEventListener('click', () => this.openPopup('A'));
    }
    if (addScoreTeamB) {
      addScoreTeamB.addEventListener('click', () => this.openPopup('B'));
    }

    // Submit button
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
      submitBtn.addEventListener('click', this.handleSubmitScore);
    }

    // Popup controls
    const closePopupBtn = document.getElementById('closePopupBtn');
    const popupButton = document.getElementById('popupButton');
    
    if (closePopupBtn) {
      closePopupBtn.addEventListener('click', this.closePopup);
    }
    if (popupButton) {
      popupButton.addEventListener('click', this.handleSaveScore);
    }

    // Delete score button (visible in edit mode only)
    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', this.handleDeleteScore);
    }

    // Close popup when clicking overlay
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.addEventListener('click', this.closePopup);
    }

    // ABBA selector
    const abbaSelect = document.getElementById('abbaStart');
    if (abbaSelect) {
      abbaSelect.addEventListener('change', this.handleAbbaChange);
    }
  }

  /**
   * ABBA selector changed
   */
  handleAbbaChange() {
    const abbaSelect = document.getElementById('abbaStart');
    this.abbaStart = abbaSelect?.value === 'F' ? 'F' : 'M';
    this.updateAbbaColumn();
    this.autoSave();
  }

  /**
   * Recompute ABBA column values for all rows
   */
  updateAbbaColumn() {
    const tbody = document.getElementById('scoringTableBody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach((row, idx) => {
      const abbaCell = row.cells?.[0];
      if (abbaCell) abbaCell.textContent = this.computeAbbaForIndex(idx);
    });
  }

  /**
   * Compute ABBA value (M/F) for given point index
   * Pattern: start,start,other,other,repeat
   */
  computeAbbaForIndex(index) {
    const start = this.abbaStart === 'F' ? 'F' : 'M';
    const other = start === 'M' ? 'F' : 'M';
    // First point is a single occurrence of start (index 0)
    if (index === 0) return start;
    // Thereafter alternate in pairs: other, other, start, start, ...
    const adjusted = index - 1;
    const block = Math.floor(adjusted / 2);
    return block % 2 === 0 ? other : start;
  }

  /**
   * Handle team selection change
   */
  handleTeamChange(teamID) {
    const selectedTeam = document.getElementById(teamID)?.value;
    const playerListElement = document.getElementById(`${teamID}List`);
    
    if (!selectedTeam || !playerListElement) return;

    const teamsData = this.dataManager.getTeamsData();
    const players = teamsData[selectedTeam] || [];

    playerListElement.value = players.join('\n');
    
    // Auto-resize textarea
    playerListElement.style.height = 'auto';
    playerListElement.style.height = playerListElement.scrollHeight + 'px';
  }

  /**
   * Open score popup
   */
  openPopup(team) {
    this.currentEditID = null;

    const overlay = document.getElementById('overlay');
    const popup = document.getElementById('scorePopup');
    const popupTitle = document.getElementById('popupTitle');
    const popupButton = document.getElementById('popupButton');
    
    if (!overlay || !popup) return;

    // Show popup
    overlay.style.display = 'block';
    popup.style.display = 'block';
    popup.dataset.team = team;

    // Set popup content
    if (popupTitle) popupTitle.textContent = 'Add Score';
    if (popupButton) popupButton.value = 'Add Score';

    // Hide delete when adding new
    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'none';

    this.populatePlayerDropdowns(team);
  }

  /**
   * Populate player dropdowns in score popup
   */
  populatePlayerDropdowns(team) {
    const scorerDropdown = document.getElementById('scorer');
    const assistDropdown = document.getElementById('assist');
    
    if (!scorerDropdown || !assistDropdown) return;

    // Clear existing options
    scorerDropdown.innerHTML = '<option value="">Select Scorer</option>';
    assistDropdown.innerHTML = '<option value="">Select Assist</option>';

    // Get players for the selected team
    const playersText = document.getElementById(
      team === 'A' ? 'teamAList' : 'teamBList'
    )?.value || '';
    
    const players = playersText ? playersText.split('\n').filter(p => p.trim()) : [];

    // Add player options
    players.forEach(player => {
      const trimmedPlayer = player.trim();
      if (trimmedPlayer) {
        scorerDropdown.appendChild(Utils.createElement('option', { value: trimmedPlayer }, trimmedPlayer));
        assistDropdown.appendChild(Utils.createElement('option', { value: trimmedPlayer }, trimmedPlayer));
      }
    });

    // Add special options
    scorerDropdown.appendChild(Utils.createElement('option', { value: SPECIAL_OPTIONS.NA }, SPECIAL_OPTIONS.NA));
    assistDropdown.appendChild(Utils.createElement('option', { value: SPECIAL_OPTIONS.NA }, SPECIAL_OPTIONS.NA));
    assistDropdown.appendChild(Utils.createElement('option', { value: SPECIAL_OPTIONS.CALLAHAN }, SPECIAL_OPTIONS.CALLAHAN));
  }

  /**
   * Handle save score
   */
  handleSaveScore() {
    const popup = document.getElementById('scorePopup');
    const team = popup?.dataset.team;
    const scorer = document.getElementById('scorer')?.value;
    const assist = document.getElementById('assist')?.value;

    if (!team || !scorer || !assist) {
      Utils.showNotification('Please select both scorer and assist.', 'error');
      return;
    }

    if (!this.currentEditID) {
      this.addNewScore(team, scorer, assist);
    } else {
      this.updateExistingScore(scorer, assist);
    }
  }

  /**
   * Add new score
   */
  addNewScore(team, scorer, assist) {
    // Update score
    if (team === 'A') {
      this.teamAScore++;
    } else {
      this.teamBScore++;
    }

    // Create log entry
    const newScoreID = Date.now().toString();
    const logEntry = this.createLogObject(newScoreID, team, scorer, assist);

    // Save to data manager
    this.dataManager.addScoreLog(logEntry);

    // Add to table
    this.addScoreToTable(logEntry);
    
    this.closePopup();
  }

  /**
   * Update existing score
   */
  updateExistingScore(scorer, assist) {
    const updated = this.dataManager.updateScoreLog(this.currentEditID, {
      Score: scorer,
      Assist: assist
    });

    if (updated) {
      this.updateScoreInTable(this.currentEditID, scorer, assist);
      this.closePopup();
    } else {
      Utils.showNotification('Could not find score to update.', 'error');
    }
  }

  /**
   * Create log object
   */
  createLogObject(scoreID, teamLetter, scorer, assist) {
    const teamAName = document.getElementById('teamA')?.value || '';
    const teamBName = document.getElementById('teamB')?.value || '';
    const gameID = `${teamAName} vs ${teamBName}`;
    const teamName = (teamLetter === 'A') ? teamAName : teamBName;

    return {
      scoreID: scoreID,
      GameID: gameID,
      Time: new Date().toLocaleString(),
      Team: teamName,
      Score: scorer,
      Assist: assist
    };
  }

  /**
   * Add score row to table
   */
  addScoreToTable(logEntry) {
    const scoringTableBody = document.getElementById('scoringTableBody');
    if (!scoringTableBody) return;

    const currentIndex = scoringTableBody.querySelectorAll('tr').length;
    const row = this.createScoreRow(logEntry, currentIndex);
    scoringTableBody.appendChild(row);
  }

  /**
   * Create score table row
   */
  createScoreRow(logEntry, index = 0) {
    const teamAName = document.getElementById('teamA')?.value || '';
    const teamLetter = (logEntry.Team === teamAName) ? 'A' : 'B';
    const row = document.createElement('tr');

    row.setAttribute('data-score-id', logEntry.scoreID);

    const scoreboard = `${this.teamAScore}:${this.teamBScore}`;
    const abba = this.computeAbbaForIndex(index);

    if (teamLetter === 'A') {
      row.innerHTML = `
        <td class=\"abba-cell\">${abba}</td>
        <td>${logEntry.Score}</td>
        <td>${logEntry.Assist}</td>
        <td class="total">${scoreboard}</td>
        <td></td>
        <td></td>
        <td><button type="button" class="edit-btn">Edit</button></td>
      `;
    } else {
      row.innerHTML = `
        <td class=\"abba-cell\">${abba}</td>
        <td></td>
        <td></td>
        <td class="total">${scoreboard}</td>
        <td>${logEntry.Score}</td>
        <td>${logEntry.Assist}</td>
        <td><button type="button" class="edit-btn">Edit</button></td>
      `;
    }

    // Add edit functionality
    const editBtn = row.querySelector('.edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => this.editScore(logEntry.scoreID));
    }

    return row;
  }

  /**
   * Update score in table
   */
  updateScoreInTable(scoreID, scorer, assist) {
    const row = document.querySelector(`tr[data-score-id="${scoreID}"]`);
    const popup = document.getElementById('scorePopup');
    
    if (!row || !popup) return;

    const teamLetter = popup.dataset.team;
    if (teamLetter === 'A') {
      row.cells[1].textContent = scorer;
      row.cells[2].textContent = assist;
    } else {
      row.cells[4].textContent = scorer;
      row.cells[5].textContent = assist;
    }
  }

  /**
   * Edit existing score
   */
  editScore(scoreID) {
    const logToEdit = this.dataManager.getScoreLog(scoreID);
    if (!logToEdit) {
      Utils.showNotification('Could not find score to edit!', 'error');
      return;
    }

    this.currentEditID = scoreID;

    // Show popup in edit mode
    const overlay = document.getElementById('overlay');
    const popup = document.getElementById('scorePopup');
    const popupTitle = document.getElementById('popupTitle');
    const popupButton = document.getElementById('popupButton');
    
    if (overlay) overlay.style.display = 'block';
    if (popup) popup.style.display = 'block';
    if (popupTitle) popupTitle.textContent = 'Edit Score';
    if (popupButton) popupButton.value = 'Update Score';

    // Show delete in edit mode
    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'inline-block';

    // Determine team
    const teamAName = document.getElementById('teamA')?.value || '';
    const teamLetter = (logToEdit.Team === teamAName) ? 'A' : 'B';
    
    if (popup) popup.dataset.team = teamLetter;

    // Populate dropdowns and set current values
    this.populatePlayerDropdowns(teamLetter);
    
    setTimeout(() => {
      const scorerDropdown = document.getElementById('scorer');
      const assistDropdown = document.getElementById('assist');
      
      if (scorerDropdown) scorerDropdown.value = logToEdit.Score;
      if (assistDropdown) assistDropdown.value = logToEdit.Assist;
    }, 0);
  }

  /**
   * Close popup
   */
  closePopup() {
    const overlay = document.getElementById('overlay');
    const popup = document.getElementById('scorePopup');
    
    if (overlay) overlay.style.display = 'none';
    if (popup) popup.style.display = 'none';

    this.currentEditID = null;
  }

  /**
   * Delete current score (from edit popup)
   */
  handleDeleteScore() {
    const scoreID = this.currentEditID;
    if (!scoreID) {
      Utils.showNotification('No score selected to delete.', 'error');
      return;
    }

    // Remove from data manager
    const removed = this.dataManager.removeScoreLog(scoreID);
    if (!removed) {
      Utils.showNotification('Could not delete score. Try again.', 'error');
      return;
    }

    // Remove row from DOM
    const row = document.querySelector(`tr[data-score-id="${scoreID}"]`);
    if (row && row.parentElement) {
      row.parentElement.removeChild(row);
    }

    // Rebuild table and counters from remaining logs
    this.rebuildTableAndCounters();

    this.closePopup();
    this.autoSave();
    Utils.showNotification('Score deleted.', 'success');
  }

  /**
   * Rebuild the scoring table and scoreboard counters from logs
   */
  rebuildTableAndCounters() {
    const scoringTableBody = document.getElementById('scoringTableBody');
    if (!scoringTableBody) return;

    // Reset counters
    this.teamAScore = 0;
    this.teamBScore = 0;

    // Clear table
    scoringTableBody.innerHTML = '';

    // Re-add rows in order, updating counters per log
    const teamAName = document.getElementById('teamA')?.value || '';
    this.dataManager.scoreLogs.forEach((logEntry, idx) => {
      const teamLetter = (logEntry.Team === teamAName) ? 'A' : 'B';
      if (teamLetter === 'A') this.teamAScore++;
      else this.teamBScore++;
      const row = this.createScoreRow(logEntry, idx);
      scoringTableBody.appendChild(row);
    });

    // Ensure ABBA column matches
    this.updateAbbaColumn();
  }

  /**
   * Handle timer toggle
   */
  handleTimerToggle() {
    this.timerManager.toggle();
  }

  /**
   * Handle timer reset
   */
  handleTimerReset() {
    const countdownTimeInput = document.getElementById('countdownTime');
    const newTime = parseInt(countdownTimeInput?.value, 10) || CONFIG.DEFAULT_TIMER_MINUTES;
    this.timerManager.reset(newTime);
  }

  /**
   * Handle seconds timer toggle
   */
  handleSecTimerToggle() {
    this.secondsTimer.toggle();
  }

  /**
   * Handle seconds timer reset
   */
  handleSecTimerReset() {
    const secInput = document.getElementById('countdownTimeSec');
    const secs = parseInt(secInput?.value, 10) || this.secondsTimer.defaultSeconds;
    this.secondsTimer.reset(secs);
  }

  /**
   * Handle score submission
   */
  async handleSubmitScore() {
    const scoreLogs = this.dataManager.scoreLogs;
    
    if (scoreLogs.length === 0) {
      Utils.showNotification('No scores have been logged.', 'error');
      return;
    }

    const teamAName = document.getElementById('teamA')?.value || '';
    const teamBName = document.getElementById('teamB')?.value || '';
    const gameID = `${teamAName} vs ${teamBName}`;
    const dateStr = new Date().toLocaleDateString();
    // Build CSV content from logs
    const header = ['GameID', 'Time', 'Team', 'Score', 'Assist'];
    const lines = [Utils.toCSVLine(header)];
    scoreLogs.forEach((log) => {
      lines.push(Utils.toCSVLine([
        log.GameID || gameID,
        log.Time || '',
        log.Team || '',
        log.Score || '',
        log.Assist || ''
      ]));
    });

    const csv = lines.join('\r\n');
    const filename = `${Utils.sanitizeFilename(gameID || 'Game')}.csv`;

    // Build export payload for Google Apps Script doPost
    const payload = {
      GameID: gameID,
      Date: dateStr,
      logs: scoreLogs.map((log) => ({
        GameID: log.GameID || gameID,
        Time: log.Time || '',
        Team: log.Team || '',
        Score: log.Score || '',
        Assist: log.Assist || ''
      }))
    };

    // Try to export to Google Sheets (if SUBMIT_URL configured)
    try {
      this.loadingManager.start();
      const ok = await this.apiManager.submitScores(payload);
      if (ok) {
        Utils.showNotification('Data has been successfully exported to Google Sheets!', 'success');
      }
    } catch (err) {
      Utils.showNotification(`Export to Google Sheets failed: ${err.message}`, 'error');
    } finally {
      this.loadingManager.stop();
    }

    // Always download CSV locally as well
    Utils.downloadTextFile(filename, csv);
    
    // Clear logs and table after actions
    this.dataManager.clearScoreLogs();
    this.rebuildTableAndCounters();
    this.currentEditID = null;

    this.dataManager.updateGameState({
      teamAScore: 0,
      teamBScore: 0,
      scoreLogs: [],
      timestamp: Date.now()
    });
    this.dataManager.saveCurrentState();

    Utils.showNotification(`CSV downloaded: ${filename}`, 'success');
  }
}

// =====================================================
// APPLICATION INITIALIZATION
// =====================================================
let app;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    app = new ScorekeeperApp();
    await app.init();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    Utils.showNotification('Failed to initialize application. Please refresh the page.', 'error');
  }
});

const noSleep = new NoSleep();

// Enable wake lock (must be triggered by user interaction)
document.getElementById('enableWakelock').addEventListener('click', function() {
  noSleep.enable();
  console.log('Wake lock enabled');
});

// Disable wake lock
function disableWakelock() {
  noSleep.disable();
  console.log('Wake lock disabled');
}

// Make app instance available globally for debugging
window.ScorekeeperApp = app;
