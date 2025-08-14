// Use secure API provided by preload script - access directly from window
if (!window.electronAPI) {
    console.error('electronAPI not available - preload script may have failed');
}

class DigitalSignage {
    constructor() {
        this.config = {};
        this.currentIndex = 0;
        this.autoRotateTimer = null;
        this.autoRotateCountdown = null;
        this.moonPhaseTimer = null;
        this.weatherTimer = null;
        this.uvTimer = null;
        this.sunriseTime = null;
        this.sunsetTime = null;
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.isTransitioning = false;
        this.isScreensaverActive = false;
        this.ipcListeners = [];
        this.eventListeners = [];
        
        this.init();
    }

    // Comprehensive cleanup method to prevent memory leaks
    cleanup() {
        window.electronAPI.log.info('Starting DigitalSignage cleanup...');
        
        // Clear all timers
        if (this.moonPhaseTimer) {
            clearTimeout(this.moonPhaseTimer);
            clearInterval(this.moonPhaseTimer);
            this.moonPhaseTimer = null;
        }
        if (this.weatherTimer) {
            clearTimeout(this.weatherTimer);
            clearInterval(this.weatherTimer);
            this.weatherTimer = null;
        }
        if (this.uvTimer) {
            clearInterval(this.uvTimer);
            this.uvTimer = null;
        }
        if (this.bitcoinHistoryTimer) {
            clearTimeout(this.bitcoinHistoryTimer);
            clearInterval(this.bitcoinHistoryTimer);
            this.bitcoinHistoryTimer = null;
        }
        if (this.autoRotateTimer) {
            clearTimeout(this.autoRotateTimer);
            this.autoRotateTimer = null;
        }
        if (this.autoRotateCountdown) {
            clearInterval(this.autoRotateCountdown);
            this.autoRotateCountdown = null;
        }
        
        // Remove all IPC listeners
        this.ipcListeners.forEach(({ event, unsubscribe }) => {
            if (unsubscribe) {
                unsubscribe();
            }
        });
        this.ipcListeners = [];
        
        // Remove all DOM event listeners
        this.eventListeners.forEach(({ element, event, listener, options }) => {
            if (element && element.removeEventListener) {
                element.removeEventListener(event, listener, options);
            }
        });
        this.eventListeners = [];
        
        window.electronAPI.log.info('DigitalSignage cleanup completed');
    }

    // Helper method to add tracked IPC listeners
    addIpcListener(event, listener) {
        const unsubscribe = window.electronAPI.on(event, listener);
        this.ipcListeners.push({ event, unsubscribe });
    }

    // Helper method to add tracked DOM event listeners
    addEventListenerTracked(element, event, listener, options) {
        element.addEventListener(event, listener, options);
        this.eventListeners.push({ element, event, listener, options });
    }

    async init() {
        // Set up IPC listeners with tracking
        this.addIpcListener('config-loaded', async (config) => {
            this.config = config;
            await this.setupApp();
        });

        this.addIpcListener('view-changed', ({ index, url, backgroundColor }) => {
            window.electronAPI.log.info(`Renderer received view-changed: index=${index}, backgroundColor=${backgroundColor}`);
            this.currentIndex = index;
            this.updateUI();
            if (backgroundColor) {
                this.applyBackgroundColor(backgroundColor);
            }
        });

        this.addIpcListener('webview-error', ({ index, url, error }) => {
            if (index === this.currentIndex) {
                this.showError(`Failed to load: ${url}\nError: ${error}`);
            }
        });

        this.addIpcListener('webview-loaded', ({ index, url }) => {
            if (index === this.currentIndex) {
                this.hideError();
            }
        });

        this.addIpcListener('config-reloaded', (newConfig) => {
            this.config = newConfig;
            this.createIndicators();
            this.currentIndex = 0;
            this.updateUI();
        });

        // Screensaver IPC listeners
        this.addIpcListener('screensaver-shown', () => {
            this.isScreensaverActive = true;
        });

        this.addIpcListener('screensaver-hidden', () => {
            this.isScreensaverActive = false;
        });

        this.addIpcListener('screensaver-error', ({ url, error }) => {
            window.electronAPI.log.error(`Screensaver failed to load: ${url}`, error);
        });

        this.addIpcListener('screensaver-loaded', () => {
            window.electronAPI.log.info('Screensaver loaded successfully');
        });

        // Request config if not received within 3 seconds
        setTimeout(async () => {
            if (!this.config.urls) {
                try {
                    this.config = await window.electronAPI.invoke('get-config');
                    await this.setupApp();
                } catch (error) {
                    window.electronAPI.log.error('Failed to load config:', error);
                    // Use default config if loading fails
                    this.config = {
                        urls: ['https://timechaincalendar.com/en', 'https://bitfeed.live/'],
                        autoRotate: false,
                        autoRotateInterval: 60000,
                        fullscreen: false,
                        enableDevTools: false
                    };
                    await this.setupApp();
                }
            }
        }, 3000);
    }

    async setupApp() {
        try {
            this.createIndicators();
            this.setupNavigation();
            this.setupGestures();
            this.setupErrorHandling();
            this.setupSettings();
            this.setupVirtualKeyboard();
            this.setupScreensaver();
            this.updateScreensaverButtonVisibility();
            this.setupExitButton();
            this.setupUVClickHandler();
            this.setupBitcoinHistoryClickHandler();
            this.setupTemperatureClickHandler();
            
            await this.setupMoonPhase();
            this.startMoonPhaseTimer();
            
            await this.setupWeatherData();
            this.startWeatherTimer();
            
            await this.setupUVData();
            this.startUVTimer();
            
            await this.setupBitcoinHistory();
            this.startBitcoinHistoryTimer();
            
            this.startAutoRotate();
            this.hideLoadingScreen();
            this.updateUI();
        } catch (error) {
            window.electronAPI.log.error('Error in setupApp:', error);
        }
    }

    createIndicators() {
        const indicatorsContainer = document.querySelector('.indicators-container');
        
        // Clear existing content
        indicatorsContainer.innerHTML = '';

        const urls = this.getUrls();
        urls.forEach((url, index) => {
            // Create indicator
            const indicator = document.createElement('div');
            indicator.className = `indicator ${index === 0 ? 'active' : ''}`;
            this.addEventListenerTracked(indicator, 'click', () => this.goToSlide(index));
            indicatorsContainer.appendChild(indicator);
        });
    }

    getUrls() {
        // Handle both legacy (string array) and new (object array) formats
        if (!this.config.urls || this.config.urls.length === 0) {
            return [];
        }
        
        return this.config.urls.map(url => {
            if (typeof url === 'string') {
                return url;
            }
            return url.url;
        });
    }

    getUrlData(index) {
        if (!this.config.urls || !this.config.urls[index]) {
            return null;
        }
        
        const url = this.config.urls[index];
        if (typeof url === 'string') {
            return { url, backgroundColor: '#000000' };
        }
        return url;
    }

    updateUI() {
        // Update indicators
        const indicators = document.querySelectorAll('.indicator');
        indicators.forEach((indicator, i) => {
            indicator.classList.toggle('active', i === this.currentIndex);
        });

        this.resetAutoRotate();
    }

    setupNavigation() {
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');

        if (prevBtn) {
            this.addEventListenerTracked(prevBtn, 'click', () => this.previousSlide());
        }
        if (nextBtn) {
            this.addEventListenerTracked(nextBtn, 'click', () => this.nextSlide());
        }

        // Keyboard navigation
        this.addEventListenerTracked(document, 'keydown', async (e) => {
            // If screensaver is active, hide it on any key press
            if (this.isScreensaverActive) {
                try {
                    await window.electronAPI.invoke('hide-screensaver');
                } catch (error) {
                    window.electronAPI.log.error('Failed to hide screensaver:', error);
                }
                return;
            }

            // Check if any modals are open - if so, don't handle slide navigation
            const settingsOverlay = document.getElementById('settings-overlay');
            const bitcoinHistoryOverlay = document.getElementById('bitcoin-history-overlay');
            const isModalOpen = (settingsOverlay && !settingsOverlay.classList.contains('hidden')) ||
                               (bitcoinHistoryOverlay && !bitcoinHistoryOverlay.classList.contains('hidden'));

            switch(e.key) {
                case 'ArrowLeft':
                    if (!isModalOpen) {
                        this.previousSlide();
                    }
                    break;
                case 'ArrowRight':
                    if (!isModalOpen) {
                        this.nextSlide();
                    }
                    break;
                case 'Escape':
                    // Exit fullscreen or close app
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    }
                    break;
                case 'F11':
                    // Toggle fullscreen
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else {
                        document.documentElement.requestFullscreen();
                    }
                    break;
            }
        });
    }

    setupGestures() {
        const gestureArea = document.getElementById('gesture-area');
        
        // Touch events
        this.addEventListenerTracked(gestureArea, 'touchstart', (e) => {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
        });

        this.addEventListenerTracked(gestureArea, 'touchmove', (e) => {
            if (!this.touchStartX || !this.touchStartY) return;

            const touchCurrentX = e.touches[0].clientX;
            const touchCurrentY = e.touches[0].clientY;
            const deltaX = touchCurrentX - this.touchStartX;
            const deltaY = touchCurrentY - this.touchStartY;

            // If horizontal movement is dominant, prevent default to handle swipe
            // Otherwise allow vertical scrolling to pass through
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
                e.preventDefault();
            }
        });

        this.addEventListenerTracked(gestureArea, 'touchend', async (e) => {
            if (!this.touchStartX || !this.touchStartY) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const deltaX = touchEndX - this.touchStartX;
            const deltaY = touchEndY - this.touchStartY;

            // If screensaver is active, hide it on any touch
            if (this.isScreensaverActive) {
                try {
                    await window.electronAPI.invoke('hide-screensaver');
                } catch (error) {
                    window.electronAPI.log.error('Failed to hide screensaver:', error);
                }
                this.touchStartX = 0;
                this.touchStartY = 0;
                return;
            }

            // Check if it's a horizontal swipe
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                e.preventDefault();
                if (deltaX > 0) {
                    this.previousSlide();
                } else {
                    this.nextSlide();
                }
            }

            this.touchStartX = 0;
            this.touchStartY = 0;
        });

        // Mouse events (for desktop testing)
        let mouseStartX = 0;
        this.addEventListenerTracked(gestureArea, 'mousedown', (e) => {
            mouseStartX = e.clientX;
        });

        this.addEventListenerTracked(gestureArea, 'mouseup', async (e) => {
            // If screensaver is active, hide it on any click
            if (this.isScreensaverActive) {
                try {
                    await window.electronAPI.invoke('hide-screensaver');
                } catch (error) {
                    window.electronAPI.log.error('Failed to hide screensaver:', error);
                }
                return;
            }

            const deltaX = e.clientX - mouseStartX;
            if (Math.abs(deltaX) > 50) {
                if (deltaX > 0) {
                    this.previousSlide();
                } else {
                    this.nextSlide();
                }
            }
        });
    }

    setupErrorHandling() {
        const retryBtn = document.getElementById('retry-btn');
        this.addEventListenerTracked(retryBtn, 'click', () => {
            this.retryCurrentSlide();
        });
    }

    setupSettings() {
        const settingsBtn = document.getElementById('settings-btn');
        const settingsOverlay = document.getElementById('settings-overlay');
        const settingsClose = document.getElementById('settings-close');
        const settingsCancel = document.getElementById('settings-cancel');
        const settingsForm = document.getElementById('settings-form');
        const addUrlBtn = document.getElementById('add-url-btn');

        // Open settings
        this.addEventListenerTracked(settingsBtn, 'click', () => {
            this.openSettings();
        });

        // Close settings
        this.addEventListenerTracked(settingsClose, 'click', () => {
            this.closeSettings();
        });

        this.addEventListenerTracked(settingsCancel, 'click', () => {
            this.closeSettings();
        });

        // Close on overlay click
        this.addEventListenerTracked(settingsOverlay, 'click', (e) => {
            if (e.target === settingsOverlay) {
                this.closeSettings();
            }
        });

        // Handle form submission
        this.addEventListenerTracked(settingsForm, 'submit', (e) => {
            e.preventDefault();
            this.saveSettings();
        });

        // Add URL button
        this.addEventListenerTracked(addUrlBtn, 'click', () => {
            this.addUrlEntry();
        });

        // Tab switching
        this.setupTabs();

        // ESC key to close settings
        this.addEventListenerTracked(document, 'keydown', (e) => {
            if (e.key === 'Escape') {
                const bitcoinHistoryOverlay = document.getElementById('bitcoin-history-overlay');
                
                // Check if Bitcoin history modal is open first
                if (bitcoinHistoryOverlay && !bitcoinHistoryOverlay.classList.contains('hidden')) {
                    this.closeBitcoinHistoryModal();
                    e.stopPropagation();
                }
                // Then check if settings is open
                else if (!settingsOverlay.classList.contains('hidden')) {
                    this.closeSettings();
                    e.stopPropagation(); // Prevent app from closing
                }
            }
        });
    }

    setupVirtualKeyboard() {
        const keyboardToggle = document.getElementById('virtual-keyboard-toggle');
        const virtualKeyboard = document.getElementById('virtual-keyboard');
        const keyButtons = virtualKeyboard.querySelectorAll('.key-btn');
        
        let isKeyboardVisible = false;
        let isCapsLock = false;
        let isShiftActive = false;
        let activeInput = null;
        let lastActiveInput = null;
        
        // Prevent toggle button from stealing focus
        this.addEventListenerTracked(keyboardToggle, 'mousedown', (e) => {
            e.preventDefault();
        });
        
        // Toggle keyboard visibility
        this.addEventListenerTracked(keyboardToggle, 'click', () => {
            isKeyboardVisible = !isKeyboardVisible;
            if (isKeyboardVisible) {
                virtualKeyboard.classList.remove('hidden');
                keyboardToggle.classList.add('active');
                // Position keyboard under active input if there is one
                if (activeInput) {
                    this.positionKeyboardUnderInput(activeInput, virtualKeyboard);
                } else {
                    // Default position at bottom center if no active input
                    this.positionKeyboardDefault(virtualKeyboard);
                }
            } else {
                virtualKeyboard.classList.add('hidden');
                keyboardToggle.classList.remove('active');
            }
        });
        
        // Track active input for focusing (using delegation for dynamic inputs)
        this.addEventListenerTracked(document, 'focusin', (e) => {
            if (e.target.matches('#settings-form input[type="text"], #settings-form input[type="url"], #settings-form input[type="password"]')) {
                activeInput = e.target;
                lastActiveInput = e.target; // Keep a backup reference
                // Position keyboard under the focused input if visible
                if (isKeyboardVisible) {
                    this.positionKeyboardUnderInput(activeInput, virtualKeyboard);
                }
            }
        });
        
        this.addEventListenerTracked(document, 'focusout', (e) => {
            if (e.target.matches('#settings-form input[type="text"], #settings-form input[type="url"], #settings-form input[type="password"]')) {
                // Only clear activeInput if we're not clicking on the virtual keyboard
                setTimeout(() => {
                    const focusedElement = document.activeElement;
                    const isKeyboardElement = virtualKeyboard.contains(focusedElement) || 
                                            focusedElement === virtualKeyboard ||
                                            focusedElement.closest('.virtual-keyboard');
                    
                    if (!isKeyboardElement && activeInput === e.target) {
                        // Check if focus moved to another input
                        if (!focusedElement || !focusedElement.matches('#settings-form input[type="text"], #settings-form input[type="url"], #settings-form input[type="password"]')) {
                            activeInput = null;
                        }
                    }
                }, 10);
            }
        });
        
        // Handle key button clicks
        keyButtons.forEach(button => {
            // Prevent buttons from stealing focus on mousedown
            this.addEventListenerTracked(button, 'mousedown', (e) => {
                e.preventDefault(); // Prevents focus from changing
            });
            
            this.addEventListenerTracked(button, 'click', (e) => {
                e.preventDefault();
                const key = button.dataset.key;
                
                // Ensure we have an active input - use fallback if needed
                if (!activeInput) {
                    const inputs = document.querySelectorAll('#settings-form input[type="text"], #settings-form input[type="url"], #settings-form input[type="password"]');
                    activeInput = Array.from(inputs).find(input => input === document.activeElement) || lastActiveInput;
                }
                
                if (!activeInput) return;
                
                // Handle special keys
                switch (key) {
                    case 'Backspace':
                        this.handleBackspace(activeInput);
                        break;
                    case 'Enter':
                        this.handleEnter(activeInput);
                        break;
                    case 'CapsLock':
                        isCapsLock = !isCapsLock;
                        this.updateCapsLockState(virtualKeyboard, isCapsLock);
                        break;
                    case 'Shift':
                        isShiftActive = !isShiftActive;
                        this.updateShiftState(virtualKeyboard, isShiftActive);
                        break;
                    default:
                        this.insertCharacter(activeInput, key, isCapsLock, isShiftActive);
                        // Reset shift after typing (but not caps lock)
                        if (isShiftActive) {
                            isShiftActive = false;
                            this.updateShiftState(virtualKeyboard, isShiftActive);
                        }
                        break;
                }
                
                // Ensure focus remains on input after key press
                if (activeInput) {
                    activeInput.focus();
                }
                
                // Also set a backup focus in case the immediate focus doesn't work
                setTimeout(() => {
                    if (activeInput && document.activeElement !== activeInput) {
                        activeInput.focus();
                    }
                }, 10);
            });
        });
        
        // Close keyboard when clicking outside settings form or virtual keyboard
        this.addEventListenerTracked(document, 'click', (e) => {
            const settingsContent = document.querySelector('.settings-content');
            const clickedOnKeyboard = virtualKeyboard.contains(e.target);
            const clickedOnSettings = settingsContent && settingsContent.contains(e.target);
            
            if (isKeyboardVisible && !clickedOnKeyboard && !clickedOnSettings) {
                virtualKeyboard.classList.add('hidden');
                keyboardToggle.classList.remove('active');
                isKeyboardVisible = false;
            }
        });
        
        // Handle window resize to reposition keyboard
        this.addEventListenerTracked(window, 'resize', () => {
            if (isKeyboardVisible) {
                if (activeInput) {
                    // Small delay to let the layout settle
                    setTimeout(() => {
                        this.positionKeyboardUnderInput(activeInput, virtualKeyboard);
                    }, 100);
                } else {
                    this.positionKeyboardDefault(virtualKeyboard);
                }
            }
        });
        
        // Handle scrolling in settings content to reposition keyboard
        const settingsContent = document.querySelector('.settings-content');
        if (settingsContent) {
            this.addEventListenerTracked(settingsContent, 'scroll', () => {
                if (isKeyboardVisible && activeInput) {
                    this.positionKeyboardUnderInput(activeInput, virtualKeyboard);
                }
            });
        }
    }
    
    handleBackspace(input) {
        // First try using execCommand if available
        try {
            if (document.execCommand) {
                input.focus();
                const deleted = document.execCommand('delete', false, null);
                if (deleted) {
                    return;
                }
            }
        } catch (e) {
            // execCommand might not work, fall back to manual method
        }
        
        // Try simulating a real backspace key event
        try {
            const backspaceEvent = new KeyboardEvent('keydown', {
                key: 'Backspace',
                code: 'Backspace',
                keyCode: 8,
                which: 8,
                bubbles: true,
                cancelable: true
            });
            
            input.focus();
            const handled = input.dispatchEvent(backspaceEvent);
            
            if (handled && backspaceEvent.defaultPrevented) {
                return; // Browser handled it
            }
        } catch (e) {
            // KeyboardEvent simulation failed
        }
        
        // Fallback to manual value manipulation
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const value = input.value;
        
        if (start !== end) {
            // Delete selected text
            input.setSelectionRange(start, end);
            input.setRangeText('', start, end, 'end');
        } else if (start > 0) {
            // Delete character before cursor
            input.setSelectionRange(start - 1, start);
            input.setRangeText('', start - 1, start, 'end');
        }
        
        // Trigger events
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    
    handleEnter(input) {
        // Try to focus next input
        const inputs = Array.from(document.querySelectorAll('#settings-form input[type="text"], #settings-form input[type="url"], #settings-form input[type="password"]'));
        const currentIndex = inputs.indexOf(input);
        if (currentIndex >= 0 && currentIndex < inputs.length - 1) {
            inputs[currentIndex + 1].focus();
        } else {
            // If this is the last input, just keep focus on current input
            input.focus();
        }
    }
    
    insertCharacter(input, key, isCapsLock, isShiftActive) {
        // Handle shift/caps logic for letters
        let charToInsert = key;
        if (key.length === 1 && key.match(/[a-zA-Z]/)) {
            if (isCapsLock || isShiftActive) {
                charToInsert = key.toUpperCase();
            } else {
                charToInsert = key.toLowerCase();
            }
        }
        
        // Handle shifted symbols
        if (isShiftActive && !key.match(/[a-zA-Z]/)) {
            const shiftMap = {
                '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
                '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
                '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
                ';': ':', "'": '"', ',': '<', '.': '>', '/': '?'
            };
            charToInsert = shiftMap[key] || key;
        }
        
        
        input.focus();
        
        // Special validation for numeric text fields (converted from number inputs)
        if (this.isNumericTextField(input)) {
            const validNumberChars = /^[0-9.\-]$/;
            if (!validNumberChars.test(charToInsert)) {
                return; // Don't insert invalid characters in numeric text fields
            }
        }
        
        // Standard text insertion logic for all inputs
        const start = input.selectionStart || 0;
        const end = input.selectionEnd || 0;
        const value = input.value || '';
        
        // Calculate new value and cursor position
        const newValue = value.substring(0, start) + charToInsert + value.substring(end);
        const newCursorPos = start + charToInsert.length;
        
        // Try using setRangeText for better compatibility
        try {
            input.setRangeText(charToInsert, start, end, 'end');
            
            // Trigger events
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        } catch (e) {
            // setRangeText not supported, fall back
        }
        
        // Fallback to direct value manipulation
        input.value = newValue;
        input.setSelectionRange(newCursorPos, newCursorPos);
        
        // Trigger events
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    updateCapsLockState(keyboard, isActive) {
        const capsButtons = keyboard.querySelectorAll('.key-caps');
        capsButtons.forEach(button => {
            if (isActive) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });
    }
    
    updateShiftState(keyboard, isActive) {
        const shiftButtons = keyboard.querySelectorAll('.key-shift');
        shiftButtons.forEach(button => {
            if (isActive) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });
        
        // Update visual highlighting of secondary symbols
        if (isActive) {
            keyboard.classList.add('shift-active');
        } else {
            keyboard.classList.remove('shift-active');
        }
    }
    
    isNumericTextField(input) {
        // Check if this is one of our numeric text fields (converted from number inputs)
        const numericFieldIds = ['rotate-interval', 'latitude', 'longitude'];
        return numericFieldIds.includes(input.id) || 
               input.hasAttribute('data-min') || 
               input.hasAttribute('data-max') ||
               input.pattern && input.pattern.includes('[0-9]');
    }
    
    positionKeyboardUnderInput(input, keyboard) {
        if (!input || !keyboard) return;
        
        // Make sure keyboard is visible to get accurate measurements
        const wasHidden = keyboard.classList.contains('hidden');
        if (wasHidden) {
            keyboard.style.visibility = 'hidden';
            keyboard.classList.remove('hidden');
        }
        
        const inputRect = input.getBoundingClientRect();
        const keyboardRect = keyboard.getBoundingClientRect();
        const keyboardHeight = keyboardRect.height || 240;
        const keyboardWidth = keyboardRect.width || 600;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Calculate position below the input with some margin
        let top = inputRect.bottom + 15;
        
        // Check if keyboard would go off the bottom of the screen
        if (top + keyboardHeight > viewportHeight - 30) {
            // Position above the input instead
            top = inputRect.top - keyboardHeight - 15;
            
            // If still off screen, position at best available spot
            if (top < 30) {
                // Find the best vertical position
                const spaceBelow = viewportHeight - inputRect.bottom;
                const spaceAbove = inputRect.top;
                
                if (spaceBelow >= spaceAbove) {
                    // Use space below, even if it means going off screen
                    top = Math.min(inputRect.bottom + 15, viewportHeight - keyboardHeight - 20);
                } else {
                    // Use space above
                    top = Math.max(30, inputRect.top - keyboardHeight - 15);
                }
            }
        }
        
        // Calculate horizontal position (try to center under input, but keep on screen)
        let left = inputRect.left + (inputRect.width / 2) - (keyboardWidth / 2);
        left = Math.max(20, Math.min(left, viewportWidth - keyboardWidth - 20));
        
        // Restore hidden state if it was hidden
        if (wasHidden) {
            keyboard.classList.add('hidden');
            keyboard.style.visibility = '';
        }
        
        // Apply positioning
        keyboard.style.top = `${Math.max(20, top)}px`;
        keyboard.style.left = `${left}px`;
        keyboard.style.transform = 'none';
    }
    
    positionKeyboardDefault(keyboard) {
        if (!keyboard) return;
        
        // Make sure keyboard is visible to get accurate measurements
        const wasHidden = keyboard.classList.contains('hidden');
        if (wasHidden) {
            keyboard.style.visibility = 'hidden';
            keyboard.classList.remove('hidden');
        }
        
        const keyboardRect = keyboard.getBoundingClientRect();
        const keyboardHeight = keyboardRect.height || 240;
        const keyboardWidth = keyboardRect.width || 600;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Restore hidden state if it was hidden
        if (wasHidden) {
            keyboard.classList.add('hidden');
            keyboard.style.visibility = '';
        }
        
        // Position at bottom center of viewport
        const top = viewportHeight - keyboardHeight - 40;
        const left = (viewportWidth / 2) - (keyboardWidth / 2);
        
        keyboard.style.top = `${Math.max(20, top)}px`;
        keyboard.style.left = `${Math.max(20, left)}px`;
        keyboard.style.transform = 'none';
    }

    setupScreensaver() {
        const screensaverBtn = document.getElementById('screensaver-btn');
        
        this.addEventListenerTracked(screensaverBtn, 'click', async () => {
            try {
                if (this.isScreensaverActive) {
                    await window.electronAPI.invoke('hide-screensaver');
                } else {
                    await window.electronAPI.invoke('show-screensaver');
                }
            } catch (error) {
                window.electronAPI.log.error('Failed to toggle screensaver:', error);
            }
        });
    }

    updateScreensaverButtonVisibility() {
        const screensaverBtn = document.getElementById('screensaver-btn');
        const isEnabled = this.config.screensaverEnabled !== false; // Default to true
        
        if (screensaverBtn) {
            screensaverBtn.style.display = isEnabled ? 'flex' : 'none';
        }
    }

    setupExitButton() {
        const exitBtn = document.getElementById('exit-btn');
        
        this.addEventListenerTracked(exitBtn, 'click', async () => {
            // Show confirmation dialog
            const confirmExit = confirm('Are you sure you want to exit the application?');
            if (confirmExit) {
                try {
                    await window.electronAPI.invoke('exit-app');
                } catch (error) {
                    window.electronAPI.log.error('Failed to exit app:', error);
                }
            }
        });
    }

    setupUVClickHandler() {
        const uvIcon = document.getElementById('uv-icon');
        
        this.addEventListenerTracked(uvIcon, 'click', async () => {
            window.electronAPI.log.info('UV Index icon clicked - refreshing data');
            await this.refreshUVData();
        });
        
        // Add cursor pointer style to indicate it's clickable
        if (uvIcon) {
            uvIcon.style.cursor = 'pointer';
        }
    }

    setupBitcoinHistoryClickHandler() {
        const historyIcon = document.getElementById('bitcoin-history-icon');
        
        this.addEventListenerTracked(historyIcon, 'click', () => {
            window.electronAPI.log.info('Bitcoin history icon clicked');
            if (this.bitcoinFacts && this.bitcoinFacts.length > 0) {
                this.showBitcoinHistoryModal(this.bitcoinFacts);
            }
        });
        
        // Add cursor pointer style to indicate it's clickable
        if (historyIcon) {
            historyIcon.style.cursor = 'pointer';
        }
    }

    setupTemperatureClickHandler() {
        const temperatureIcon = document.getElementById('temperature-icon');
        
        this.addEventListenerTracked(temperatureIcon, 'click', async () => {
            window.electronAPI.log.info('Temperature icon clicked - refreshing data');
            await this.refreshUVData(); // This will refresh both UV and temperature
        });
        
        // Add cursor pointer style to indicate it's clickable
        if (temperatureIcon) {
            temperatureIcon.style.cursor = 'pointer';
        }
    }

    async setupMoonPhase() {
        const moonPhaseGroup = document.querySelector('.moon-phase-group');
        
        // Check if moon phase should be shown
        if (this.config.showMoonPhase === false) {
            if (moonPhaseGroup) {
                moonPhaseGroup.style.display = 'none';
            }
            return;
        }
        
        // Show moon phase group
        if (moonPhaseGroup) {
            moonPhaseGroup.style.display = 'flex';
        }
        
        try {
            const moonPhaseElement = document.getElementById('moon-phase');
            const moonPhaseNameElement = document.getElementById('moon-phase-name');
            if (moonPhaseElement) {
                const moonData = await window.electronAPI.invoke('get-moon-phase');
                moonPhaseElement.textContent = moonData.emoji;
                
                if (moonPhaseNameElement) {
                    moonPhaseNameElement.textContent = moonData.phase;
                }
            }
        } catch (error) {
            window.electronAPI.log.error('Moon phase setup failed:', error);
            // Fallback to a default moon emoji
            const moonPhaseElement = document.getElementById('moon-phase');
            const moonPhaseNameElement = document.getElementById('moon-phase-name');
            if (moonPhaseElement) {
                moonPhaseElement.textContent = '🌙';
            }
            if (moonPhaseNameElement) {
                moonPhaseNameElement.textContent = 'Unknown';
            }
        }
    }


    startMoonPhaseTimer() {
        // Clear existing timer
        if (this.moonPhaseTimer) {
            clearTimeout(this.moonPhaseTimer);
        }

        // Only start timer if moon phase is enabled
        if (this.config.showMoonPhase === false) {
            return;
        }

        // Calculate milliseconds until next 1 AM
        const now = new Date();
        const next1AM = new Date();
        next1AM.setHours(1, 0, 0, 0); // Set to 1:00:00 AM

        // If it's already past 1 AM today, set for tomorrow
        if (now >= next1AM) {
            next1AM.setDate(next1AM.getDate() + 1);
        }

        const msUntil1AM = next1AM.getTime() - now.getTime();
        
        window.electronAPI.log.info(`Moon phase will refresh at: ${next1AM.toLocaleString()}`);

        // Set timer for next 1 AM
        this.moonPhaseTimer = setTimeout(() => {
            this.refreshMoonPhase();
            // Set up daily recurring timer (24 hours = 86400000 ms)
            this.moonPhaseTimer = setInterval(() => {
                this.refreshMoonPhase();
            }, 86400000);
        }, msUntil1AM);
    }

    async refreshMoonPhase() {
        window.electronAPI.log.info('Refreshing moon phase at:', new Date().toLocaleString());
        if (this.config.showMoonPhase !== false) {
            await this.setupMoonPhase();
        }
    }

    startBitcoinHistoryTimer() {
        // Clear existing timer
        if (this.bitcoinHistoryTimer) {
            clearTimeout(this.bitcoinHistoryTimer);
        }

        // Calculate milliseconds until next midnight (00:00)
        const now = new Date();
        const nextMidnight = new Date();
        nextMidnight.setHours(24, 0, 0, 0); // Set to next midnight
        
        const msUntilMidnight = nextMidnight.getTime() - now.getTime();
        
        window.electronAPI.log.info(`Bitcoin history will refresh at: ${nextMidnight.toLocaleString()}`);

        // Set timer for next midnight
        this.bitcoinHistoryTimer = setTimeout(() => {
            this.refreshBitcoinHistory();
            // Set up daily recurring timer (24 hours = 86400000 ms)
            this.bitcoinHistoryTimer = setInterval(() => {
                this.refreshBitcoinHistory();
            }, 86400000);
        }, msUntilMidnight);
    }

    async refreshBitcoinHistory() {
        window.electronAPI.log.info('Refreshing Bitcoin history at:', new Date().toLocaleString());
        await this.setupBitcoinHistory();
    }

    async setupWeatherData() {
        // Check if weather should be shown
        if (this.config.showWeather === false) {
            this.hideWeatherDisplay();
            return;
        }

        try {
            // Use configured coordinates or default to New York
            const latitude = this.config.latitude || 40.7128;
            const longitude = this.config.longitude || -74.0060;
            
            const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=sunrise,sunset,uv_index_max&timezone=auto&forecast_days=1`
            );
            
            if (!response.ok) {
                throw new Error('Weather API request failed');
            }
            
            const data = await response.json();
            this.updateWeatherDisplay(data);
            
        } catch (error) {
            window.electronAPI.log.error('Weather data setup failed:', error);
            // Fallback display
            const sunriseTimeElement = document.getElementById('sunrise-time');
            const sunsetTimeElement = document.getElementById('sunset-time');
            if (sunriseTimeElement) {
                sunriseTimeElement.textContent = '--:--';
            }
            if (sunsetTimeElement) {
                sunsetTimeElement.textContent = '--:--';
            }
        }
    }

    updateWeatherDisplay(data) {
        const sunriseTimeElement = document.getElementById('sunrise-time');
        const sunsetTimeElement = document.getElementById('sunset-time');
        
        // Show weather elements
        this.showWeatherDisplay();
        
        // Determine time format
        const use12Hour = this.config.timeFormat === '12';
        
        if (sunriseTimeElement && data.daily && data.daily.sunrise && data.daily.sunrise[0]) {
            this.sunriseTime = new Date(data.daily.sunrise[0]);
            const timeString = this.sunriseTime.toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: use12Hour 
            });
            sunriseTimeElement.textContent = timeString;
        }
        
        if (sunsetTimeElement && data.daily && data.daily.sunset && data.daily.sunset[0]) {
            this.sunsetTime = new Date(data.daily.sunset[0]);
            const timeString = this.sunsetTime.toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: use12Hour 
            });
            sunsetTimeElement.textContent = timeString;
        }
    }

    showWeatherDisplay() {
        const sunriseGroup = document.querySelector('.sunrise-group');
        const sunsetGroup = document.querySelector('.sunset-group');
        
        if (sunriseGroup) {
            sunriseGroup.style.display = 'flex';
        }
        if (sunsetGroup) {
            sunsetGroup.style.display = 'flex';
        }
    }

    hideWeatherDisplay() {
        const sunriseGroup = document.querySelector('.sunrise-group');
        const sunsetGroup = document.querySelector('.sunset-group');
        
        if (sunriseGroup) {
            sunriseGroup.style.display = 'none';
        }
        if (sunsetGroup) {
            sunsetGroup.style.display = 'none';
        }
    }

    startWeatherTimer() {
        // Clear existing timer
        if (this.weatherTimer) {
            clearTimeout(this.weatherTimer);
        }

        // Calculate milliseconds until next 3 AM for weather update
        const now = new Date();
        const next3AM = new Date();
        next3AM.setHours(3, 0, 0, 0);

        // If it's already past 3 AM today, set for tomorrow
        if (now >= next3AM) {
            next3AM.setDate(next3AM.getDate() + 1);
        }

        const msUntil3AM = next3AM.getTime() - now.getTime();
        
        window.electronAPI.log.info(`Weather data will refresh at: ${next3AM.toLocaleString()}`);

        // Set timer for next 3 AM
        this.weatherTimer = setTimeout(() => {
            this.refreshWeatherData();
            // Set up daily recurring timer (24 hours = 86400000 ms)
            this.weatherTimer = setInterval(() => {
                this.refreshWeatherData();
            }, 86400000);
        }, msUntil3AM);
    }

    refreshWeatherData() {
        window.electronAPI.log.info('Refreshing weather data at:', new Date().toLocaleString());
        this.setupWeatherData();
    }

    async setupUVData() {
        // Check if weather elements should be shown
        const shouldShowUV = this.config.showUV !== false; // Default to true
        const shouldShowTemperature = this.config.showTemperature !== false; // Default to true
        const shouldShowHumidity = this.config.showHumidity !== false; // Default to true
        
        if (!shouldShowUV) {
            this.hideUVDisplay();
        }
        
        if (!shouldShowTemperature) {
            this.hideTemperatureDisplay();
        }
        
        if (!shouldShowHumidity) {
            this.hideHumidityDisplay();
        }
        
        // If all are disabled, return early
        if (!shouldShowUV && !shouldShowTemperature && !shouldShowHumidity) {
            return;
        }

        // Check if it's currently daylight hours
        if (!this.isDaylight()) {
            window.electronAPI.log.info('UV Index not fetched - outside daylight hours');
            
            // Show UV display but with nighttime value (only if enabled)
            if (shouldShowUV) {
                this.showUVDisplay();
                const uvValueElement = document.getElementById('uv-value');
                if (uvValueElement) {
                    uvValueElement.textContent = '0';
                    uvValueElement.style.borderColor = 'rgba(0, 128, 0, 0.7)'; // Green for no UV at night
                }
            }
            
            // Still try to get current temperature and humidity even at night (only if enabled)
            if (shouldShowTemperature || shouldShowHumidity) {
                if (shouldShowTemperature) {
                    this.showTemperatureDisplay();
                }
                if (shouldShowHumidity) {
                    this.showHumidityDisplay();
                }
                
                try {
                    const latitude = this.config.latitude || 40.7128;
                    const longitude = this.config.longitude || -74.0060;
                    
                    let nightParams = [];
                    if (shouldShowTemperature) {
                        nightParams.push('temperature_2m');
                    }
                    if (shouldShowHumidity) {
                        nightParams.push('relative_humidity_2m');
                    }
                    
                    const response = await fetch(
                        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=${nightParams.join(',')}&timezone=auto`
                    );
                    
                    if (response.ok) {
                        const data = await response.json();
                        const temperatureValueElement = document.getElementById('temperature-value');
                        const humidityValueElement = document.getElementById('humidity-value');
                        
                        if (shouldShowTemperature && temperatureValueElement && data.current && typeof data.current.temperature_2m === 'number') {
                            const temperature = this.convertTemperature(data.current.temperature_2m);
                            const unit = this.getTemperatureUnit();
                            temperatureValueElement.textContent = `${temperature}°${unit}`;
                        }
                        
                        if (shouldShowHumidity && humidityValueElement && data.current && typeof data.current.relative_humidity_2m === 'number') {
                            const humidity = Math.round(data.current.relative_humidity_2m);
                            humidityValueElement.textContent = `${humidity}%`;
                        }
                    }
                } catch (error) {
                    window.electronAPI.log.error('Failed to fetch nighttime temperature:', error);
                }
            }
            return;
        }

        try {
            // Use configured coordinates or default to New York
            const latitude = this.config.latitude || 40.7128;
            const longitude = this.config.longitude || -74.0060;
            
            // Build API request based on what's enabled
            let currentParams = [];
            if (shouldShowUV) {
                currentParams.push('uv_index');
            }
            if (shouldShowTemperature) {
                currentParams.push('temperature_2m');
            }
            if (shouldShowHumidity) {
                currentParams.push('relative_humidity_2m');
            }
            
            const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=${currentParams.join(',')}&timezone=auto`
            );
            
            if (!response.ok) {
                throw new Error('Weather API request failed');
            }
            
            const data = await response.json();
            this.updateUVDisplay(data, shouldShowUV, shouldShowTemperature, shouldShowHumidity);
            
        } catch (error) {
            window.electronAPI.log.error('Weather data setup failed:', error);
            // Fallback display
            if (shouldShowUV) {
                const uvValueElement = document.getElementById('uv-value');
                if (uvValueElement) {
                    uvValueElement.textContent = '--';
                    uvValueElement.style.borderColor = 'white';
                }
            }
            if (shouldShowTemperature) {
                const temperatureValueElement = document.getElementById('temperature-value');
                if (temperatureValueElement) {
                    const unit = this.getTemperatureUnit();
                    temperatureValueElement.textContent = `--°${unit}`;
                }
            }
            // Show humidity fallback only if enabled
            if (shouldShowHumidity) {
                this.showHumidityDisplay();
                const humidityValueElement = document.getElementById('humidity-value');
                if (humidityValueElement) {
                    humidityValueElement.textContent = '--%';
                }
            }
        }
    }

    updateUVDisplay(data, shouldShowUV = true, shouldShowTemperature = true, shouldShowHumidity = true) {
        const uvValueElement = document.getElementById('uv-value');
        const temperatureValueElement = document.getElementById('temperature-value');
        const humidityValueElement = document.getElementById('humidity-value');
        
        // Show UV element only if enabled
        if (shouldShowUV) {
            this.showUVDisplay();
            if (uvValueElement && data.current && typeof data.current.uv_index === 'number') {
                const uvIndex = Math.round(data.current.uv_index);
                uvValueElement.textContent = uvIndex.toString();
                
                // Color code based on UV Index levels
                const uvColor = this.getUVColor(uvIndex);
                uvValueElement.style.borderColor = uvColor;
            }
        }
        
        // Show temperature element only if enabled
        if (shouldShowTemperature) {
            this.showTemperatureDisplay();
            if (temperatureValueElement && data.current && typeof data.current.temperature_2m === 'number') {
                const temperature = this.convertTemperature(data.current.temperature_2m);
                const unit = this.getTemperatureUnit();
                temperatureValueElement.textContent = `${temperature}°${unit}`;
            }
        }
        
        // Show humidity only if enabled
        if (shouldShowHumidity) {
            this.showHumidityDisplay();
            if (humidityValueElement && data.current && typeof data.current.relative_humidity_2m === 'number') {
                const humidity = Math.round(data.current.relative_humidity_2m);
                humidityValueElement.textContent = `${humidity}%`;
            }
        }
    }

    getUVColor(uvIndex) {
        // WHO UV Index color scale
        if (uvIndex <= 2) return 'rgba(0, 128, 0, 0.7)';      // Green (Low)
        if (uvIndex <= 5) return 'rgba(255, 255, 0, 0.7)';    // Yellow (Moderate)
        if (uvIndex <= 7) return 'rgba(255, 165, 0, 0.7)';    // Orange (High)
        if (uvIndex <= 10) return 'rgba(255, 0, 0, 0.7)';     // Red (Very High)
        return 'rgba(128, 0, 128, 0.7)';                      // Purple (Extreme)
    }

    convertTemperature(celsius) {
        // Convert temperature based on config setting
        const unit = this.config.temperatureUnit || 'C';
        if (unit === 'F') {
            const fahrenheit = (celsius * 9/5) + 32;
            return Math.round(fahrenheit);
        }
        return Math.round(celsius);
    }

    getTemperatureUnit() {
        const unit = this.config.temperatureUnit || 'C';
        return unit === 'F' ? 'F' : 'C';
    }

    isDaylight() {
        if (!this.sunriseTime || !this.sunsetTime) {
            return true; // Default to fetching if we don't have sunrise/sunset data yet
        }
        
        const now = new Date();
        return now >= this.sunriseTime && now <= this.sunsetTime;
    }

    showUVDisplay() {
        const uvGroup = document.querySelector('.uv-index-group');
        if (uvGroup) {
            uvGroup.style.display = 'flex';
        }
    }

    hideUVDisplay() {
        const uvGroup = document.querySelector('.uv-index-group');
        if (uvGroup) {
            uvGroup.style.display = 'none';
        }
    }

    showTemperatureDisplay() {
        const temperatureGroup = document.querySelector('.temperature-group');
        if (temperatureGroup) {
            temperatureGroup.style.display = 'flex';
        }
    }

    hideTemperatureDisplay() {
        const temperatureGroup = document.querySelector('.temperature-group');
        if (temperatureGroup) {
            temperatureGroup.style.display = 'none';
        }
    }

    showHumidityDisplay() {
        const humidityGroup = document.querySelector('.humidity-group');
        if (humidityGroup) {
            humidityGroup.style.display = 'flex';
        }
    }

    hideHumidityDisplay() {
        const humidityGroup = document.querySelector('.humidity-group');
        if (humidityGroup) {
            humidityGroup.style.display = 'none';
        }
    }

    startUVTimer() {
        // Clear existing timer
        if (this.uvTimer) {
            clearInterval(this.uvTimer);
        }

        // Only start timer if UV Index is enabled
        if (this.config.showUV === false) {
            return;
        }

        // Get update frequency in minutes (default 60)
        const updateFrequency = this.config.uvUpdateFrequency || 60;
        const intervalMs = updateFrequency * 60 * 1000; // Convert to milliseconds
        
        window.electronAPI.log.info(`UV Index will refresh every ${updateFrequency} minutes`);

        // Set up recurring timer
        this.uvTimer = setInterval(() => {
            this.refreshUVData();
        }, intervalMs);
    }

    refreshUVData() {
        window.electronAPI.log.info('Refreshing UV Index data at:', new Date().toLocaleString());
        this.setupUVData();
    }

    async setupBitcoinHistory() {
        try {
            const facts = await window.electronAPI.invoke('get-todays-bitcoin-fact');
            
            if (facts && facts.length > 0) {
                // Store facts for modal display
                this.bitcoinFacts = facts;
                this.currentFactIndex = 0;
                // Show the Bitcoin history icon
                this.showBitcoinHistoryIcon();
            } else {
                // Hide the Bitcoin history icon if no facts for today
                this.bitcoinFacts = [];
                this.hideBitcoinHistoryIcon();
            }
        } catch (error) {
            window.electronAPI.log.error('Bitcoin history setup failed:', error);
            this.bitcoinFacts = [];
            this.hideBitcoinHistoryIcon();
        }
    }

    showBitcoinHistoryIcon() {
        const historyGroup = document.getElementById('bitcoin-history-group');
        if (historyGroup) {
            historyGroup.style.display = 'flex';
        }
    }

    hideBitcoinHistoryIcon() {
        const historyGroup = document.getElementById('bitcoin-history-group');
        if (historyGroup) {
            historyGroup.style.display = 'none';
        }
    }

    async showBitcoinHistoryModal(facts) {
        if (!facts || facts.length === 0) return;
        
        this.bitcoinFacts = facts;
        this.currentFactIndex = 0;
        
        const overlay = document.getElementById('bitcoin-history-overlay');
        const dateElement = document.getElementById('bitcoin-history-date');
        const titleElement = document.getElementById('bitcoin-history-title');
        const descriptionElement = document.getElementById('bitcoin-history-description');
        const counterElement = document.getElementById('bitcoin-history-counter');
        const prevButton = document.getElementById('bitcoin-history-prev');
        const nextButton = document.getElementById('bitcoin-history-next');

        if (overlay && dateElement && titleElement && descriptionElement && counterElement) {
            // Notify main process that modal is opening
            try {
                await window.electronAPI.invoke('set-modal-state', true);
            } catch (error) {
                window.electronAPI.log.error('Failed to set modal state:', error);
            }
            
            // Hide BrowserView so it doesn't cover the modal
            try {
                await window.electronAPI.invoke('hide-browser-view');
            } catch (error) {
                window.electronAPI.log.error('Failed to hide browser view:', error);
            }

            // Pause auto-rotate while modal is open
            this.pauseAutoRotate();

            // Show the modal
            overlay.classList.remove('hidden');
            
            // Display the current fact
            this.updateBitcoinFactDisplay();
            
            // Set up navigation handlers
            if (prevButton) {
                prevButton.onclick = () => this.showPreviousFact();
            }
            if (nextButton) {
                nextButton.onclick = () => this.showNextFact();
            }
            
            // Set up close handlers
            const closeButton = document.getElementById('bitcoin-history-close');
            if (closeButton) {
                closeButton.onclick = () => this.closeBitcoinHistoryModal();
            }
            
            // Close on overlay click
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    this.closeBitcoinHistoryModal();
                }
            };
            
            // Add keyboard navigation
            this.bitcoinModalKeyHandler = (e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.showPreviousFact();
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.showNextFact();
                }
            };
            document.addEventListener('keydown', this.bitcoinModalKeyHandler);
        }
    }

    updateBitcoinFactDisplay() {
        if (!this.bitcoinFacts || this.bitcoinFacts.length === 0) return;
        
        const fact = this.bitcoinFacts[this.currentFactIndex];
        const dateElement = document.getElementById('bitcoin-history-date');
        const titleElement = document.getElementById('bitcoin-history-title');
        const descriptionElement = document.getElementById('bitcoin-history-description');
        const counterElement = document.getElementById('bitcoin-history-counter');
        const prevButton = document.getElementById('bitcoin-history-prev');
        const nextButton = document.getElementById('bitcoin-history-next');
        
        // Format the date nicely (avoid timezone issues with manual parsing)
        const formattedDate = new Date(fact.year, fact.month - 1, fact.day).toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        
        // Update content
        if (dateElement) dateElement.textContent = formattedDate;
        if (titleElement) titleElement.textContent = fact.title;
        if (descriptionElement) descriptionElement.textContent = fact.description;
        if (counterElement) counterElement.textContent = `${this.currentFactIndex + 1} / ${this.bitcoinFacts.length}`;
        
        // Update navigation buttons
        if (prevButton) {
            prevButton.disabled = this.currentFactIndex === 0;
        }
        if (nextButton) {
            nextButton.disabled = this.currentFactIndex === this.bitcoinFacts.length - 1;
        }
        
        // Hide navigation if only one fact
        const navigation = document.querySelector('.bitcoin-history-navigation');
        if (navigation) {
            navigation.style.display = this.bitcoinFacts.length > 1 ? 'flex' : 'none';
        }
    }

    showPreviousFact() {
        if (this.currentFactIndex > 0) {
            this.currentFactIndex--;
            this.updateBitcoinFactDisplay();
        }
    }

    showNextFact() {
        if (this.currentFactIndex < this.bitcoinFacts.length - 1) {
            this.currentFactIndex++;
            this.updateBitcoinFactDisplay();
        }
    }

    async closeBitcoinHistoryModal() {
        const overlay = document.getElementById('bitcoin-history-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
        
        // Notify main process that modal is closed
        try {
            await window.electronAPI.invoke('set-modal-state', false);
        } catch (error) {
            window.electronAPI.log.error('Failed to set modal state:', error);
        }
        
        // Remove keyboard handler
        if (this.bitcoinModalKeyHandler) {
            document.removeEventListener('keydown', this.bitcoinModalKeyHandler);
            this.bitcoinModalKeyHandler = null;
        }
        
        // Resume auto-rotate when modal is closed
        this.resumeAutoRotate();
        
        // Show BrowserView again
        try {
            await window.electronAPI.invoke('show-browser-view');
        } catch (error) {
            window.electronAPI.log.error('Failed to show browser view:', error);
        }
    }

    setupTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');
        const tabContents = document.querySelectorAll('.tab-content');

        tabButtons.forEach(button => {
            this.addEventListenerTracked(button, 'click', () => {
                const targetTab = button.getAttribute('data-tab');
                
                // Remove active class from all buttons and contents
                tabButtons.forEach(btn => btn.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));
                
                // Add active class to clicked button and corresponding content
                button.classList.add('active');
                const targetContent = document.getElementById(`${targetTab}-tab`);
                if (targetContent) {
                    targetContent.classList.add('active');
                }
            });
        });
    }

    async openSettings() {
        const settingsOverlay = document.getElementById('settings-overlay');
        
        // Notify main process that modal is opening
        try {
            await window.electronAPI.invoke('set-modal-state', true);
        } catch (error) {
            window.electronAPI.log.error('Failed to set modal state:', error);
        }
        
        // Hide BrowserView so it doesn't cover the popup
        try {
            await window.electronAPI.invoke('hide-browser-view');
        } catch (error) {
            window.electronAPI.log.error('Failed to hide browser view:', error);
        }
        
        // Pause auto-rotate while settings modal is open
        this.pauseAutoRotate();
        
        // Populate form with current config
        this.populateSettingsForm();
        
        // Show settings popup
        settingsOverlay.classList.remove('hidden');
    }

    async closeSettings() {
        const settingsOverlay = document.getElementById('settings-overlay');
        settingsOverlay.classList.add('hidden');
        
        // Hide virtual keyboard when settings close
        const virtualKeyboard = document.getElementById('virtual-keyboard');
        const keyboardToggle = document.getElementById('virtual-keyboard-toggle');
        if (virtualKeyboard && keyboardToggle) {
            virtualKeyboard.classList.add('hidden');
            keyboardToggle.classList.remove('active');
        }
        
        // Notify main process that modal is closed
        try {
            await window.electronAPI.invoke('set-modal-state', false);
        } catch (error) {
            window.electronAPI.log.error('Failed to set modal state:', error);
        }
        
        // Resume auto-rotate when settings modal is closed
        this.resumeAutoRotate();
        
        // Show BrowserView again
        try {
            await window.electronAPI.invoke('show-browser-view');
        } catch (error) {
            window.electronAPI.log.error('Failed to show browser view:', error);
        }
    }

    populateSettingsForm() {
        const urlsContainer = document.getElementById('urls-container');
        const autoRotateCheck = document.getElementById('auto-rotate');
        const fullscreenCheck = document.getElementById('fullscreen');
        const rotateIntervalInput = document.getElementById('rotate-interval');
        const devToolsCheck = document.getElementById('dev-tools');
        const showMoonPhaseCheck = document.getElementById('show-moon-phase');
        const showWeatherCheck = document.getElementById('show-weather');
        const showUVCheck = document.getElementById('show-uv');
        const showTemperatureCheck = document.getElementById('show-temperature');
        const showHumidityCheck = document.getElementById('show-humidity');
        const timeFormatSelect = document.getElementById('time-format');
        const temperatureUnitSelect = document.getElementById('temperature-unit');
        const latitudeInput = document.getElementById('latitude');
        const longitudeInput = document.getElementById('longitude');
        const uvUpdateFrequencySelect = document.getElementById('uv-update-frequency');
        const screensaverUrlInput = document.getElementById('screensaver-url');
        const screensaverEnabledCheck = document.getElementById('screensaver-enabled');
        const useQuotesScreensaverCheck = document.getElementById('use-quotes-screensaver');
        const autostartEnabledCheck = document.getElementById('autostart-enabled');

        // Clear existing URL entries
        urlsContainer.innerHTML = '';

        // Handle legacy URLs format (backward compatibility)
        const urls = this.config.urls || [];
        const urlsData = urls.map(url => {
            if (typeof url === 'string') {
                return { url, backgroundColor: '#000000' };
            }
            return url;
        });

        // Create URL entries
        urlsData.forEach((urlData, index) => {
            this.createUrlEntry(urlData.url, urlData.backgroundColor, index);
        });

        // Add at least one empty entry if no URLs exist
        if (urlsData.length === 0) {
            this.createUrlEntry('', '#000000', 0);
        }
        
        // Populate checkboxes
        autoRotateCheck.checked = this.config.autoRotate;
        fullscreenCheck.checked = this.config.fullscreen;
        devToolsCheck.checked = this.config.enableDevTools;
        showMoonPhaseCheck.checked = this.config.showMoonPhase !== false; // Default to true
        showWeatherCheck.checked = this.config.showWeather !== false; // Default to true
        showUVCheck.checked = this.config.showUV !== false; // Default to true
        showTemperatureCheck.checked = this.config.showTemperature !== false; // Default to true
        showHumidityCheck.checked = this.config.showHumidity !== false; // Default to true
        
        // Populate time format
        timeFormatSelect.value = this.config.timeFormat || '24'; // Default to 24-hour
        
        // Populate temperature unit
        temperatureUnitSelect.value = this.config.temperatureUnit || 'C'; // Default to Celsius
        
        // Populate coordinates
        latitudeInput.value = this.config.latitude || 40.7128; // Default to New York
        longitudeInput.value = this.config.longitude || -74.0060;
        
        // Populate UV update frequency
        uvUpdateFrequencySelect.value = this.config.uvUpdateFrequency || 60; // Default to 60 minutes
        
        // Populate screensaver settings
        const isUsingQuotes = this.config.screensaverUrl === '@Quotes/index.html';
        useQuotesScreensaverCheck.checked = isUsingQuotes;
        screensaverUrlInput.value = isUsingQuotes ? '' : (this.config.screensaverUrl || 'https://lodev09.github.io/web-screensavers/jellyfish/');
        screensaverUrlInput.disabled = isUsingQuotes;
        screensaverEnabledCheck.checked = this.config.screensaverEnabled !== false; // Default to true
        
        // Add event listener for the quotes checkbox
        useQuotesScreensaverCheck.addEventListener('change', () => {
            if (useQuotesScreensaverCheck.checked) {
                screensaverUrlInput.disabled = true;
                screensaverUrlInput.value = '';
            } else {
                screensaverUrlInput.disabled = false;
                screensaverUrlInput.value = 'https://lodev09.github.io/web-screensavers/jellyfish/';
            }
        });
        
        // Populate interval (convert milliseconds to minutes)
        rotateIntervalInput.value = this.config.autoRotateInterval / 60000;
        
        // Populate autostart and WiFi settings (Linux only)
        this.updateLinuxSettings();
    }

    async updateLinuxSettings() {
        const autostartEnabledCheck = document.getElementById('autostart-enabled');
        const autostartStatusText = document.getElementById('autostart-status-text');
        const wifiStatusText = document.getElementById('wifi-status-text');
        const linuxTabButton = document.getElementById('linux-tab-button');
        
        try {
            // Check if we're on Linux and get autostart status
            const autostartStatus = await window.electronAPI.invoke('get-autostart-status');
            
            if (autostartStatus.isLinux) {
                // Show Linux tab
                if (linuxTabButton) {
                    linuxTabButton.style.display = 'block';
                }
                
                // Update autostart checkbox based on current status
                if (autostartEnabledCheck) {
                    autostartEnabledCheck.checked = autostartStatus.enabled;
                }
                
                // Update autostart status text
                if (autostartStatusText) {
                    if (autostartStatus.enabled) {
                        autostartStatusText.textContent = '✓ Autostart is enabled';
                        autostartStatusText.style.color = '#4CAF50';
                    } else {
                        autostartStatusText.textContent = '✗ Autostart is disabled';
                        autostartStatusText.style.color = '#f44336';
                    }
                }
                
                // Update WiFi status
                await this.updateWifiStatus();
                
                // Set up WiFi management controls
                this.setupWifiControls();
                
            } else {
                // Hide Linux tab on non-Linux systems
                if (linuxTabButton) {
                    linuxTabButton.style.display = 'none';
                }
            }
        } catch (error) {
            window.electronAPI.log.error('Failed to get Linux settings status:', error);
            
            // Hide Linux tab on error
            if (linuxTabButton) {
                linuxTabButton.style.display = 'none';
            }
            
            if (autostartStatusText) {
                autostartStatusText.textContent = 'Error checking status';
                autostartStatusText.style.color = '#f44336';
            }
            
            if (wifiStatusText) {
                wifiStatusText.textContent = 'Error checking WiFi';
                wifiStatusText.style.color = '#f44336';
            }
        }
    }
    
    async updateWifiStatus() {
        const wifiStatusText = document.getElementById('wifi-status-text');
        const wifiDisconnectBtn = document.getElementById('wifi-disconnect-btn');
        
        try {
            const wifiStatus = await window.electronAPI.invoke('get-wifi-status');
            
            if (wifiStatusText && wifiDisconnectBtn) {
                if (wifiStatus.connected) {
                    wifiStatusText.textContent = `✓ Connected to: ${wifiStatus.networkName}`;
                    wifiStatusText.style.color = '#4CAF50';
                    wifiDisconnectBtn.style.display = 'inline-block';
                } else {
                    wifiStatusText.textContent = '✗ Not connected';
                    wifiStatusText.style.color = '#f44336';
                    wifiDisconnectBtn.style.display = 'none';
                }
            }
        } catch (error) {
            window.electronAPI.log.error('Failed to get WiFi status:', error);
            if (wifiStatusText) {
                wifiStatusText.textContent = 'Error checking WiFi';
                wifiStatusText.style.color = '#f44336';
            }
            if (wifiDisconnectBtn) {
                wifiDisconnectBtn.style.display = 'none';
            }
        }
    }
    
    setupWifiControls() {
        const wifiRefreshBtn = document.getElementById('wifi-refresh-btn');
        const wifiDisconnectBtn = document.getElementById('wifi-disconnect-btn');
        const wifiConnectBtn = document.getElementById('wifi-connect-btn');
        
        // Refresh networks
        if (wifiRefreshBtn) {
            this.addEventListenerTracked(wifiRefreshBtn, 'click', () => {
                this.refreshWifiNetworks();
            });
        }
        
        // Disconnect from current network
        if (wifiDisconnectBtn) {
            this.addEventListenerTracked(wifiDisconnectBtn, 'click', () => {
                this.disconnectWifi();
            });
        }
        
        // Connect to selected network
        if (wifiConnectBtn) {
            this.addEventListenerTracked(wifiConnectBtn, 'click', () => {
                this.connectToSelectedNetwork();
            });
        }
    }
    
    async refreshWifiNetworks() {
        const wifiLoading = document.getElementById('wifi-loading');
        const wifiNetworksSelect = document.getElementById('wifi-networks-select');
        
        if (wifiLoading) {
            wifiLoading.style.display = 'flex';
        }
        
        if (wifiNetworksSelect) {
            wifiNetworksSelect.innerHTML = '<option disabled>Scanning...</option>';
        }
        
        try {
            const networks = await window.electronAPI.invoke('scan-wifi');
            
            if (wifiLoading) {
                wifiLoading.style.display = 'none';
            }
            
            if (wifiNetworksSelect) {
                this.displayWifiNetworks(networks);
            }
        } catch (error) {
            window.electronAPI.log.error('Failed to scan WiFi networks:', error);
            
            if (wifiLoading) {
                wifiLoading.style.display = 'none';
            }
            
            if (wifiNetworksSelect) {
                wifiNetworksSelect.innerHTML = '<option disabled>Error scanning networks</option>';
            }
        }
    }
    
    displayWifiNetworks(networks) {
        const wifiNetworksSelect = document.getElementById('wifi-networks-select');
        
        if (!wifiNetworksSelect) return;
        
        wifiNetworksSelect.innerHTML = '';
        
        if (!networks || networks.length === 0) {
            wifiNetworksSelect.innerHTML = '<option disabled>No networks found</option>';
            return;
        }
        
        networks.forEach(network => {
            const option = document.createElement('option');
            const securityIcon = network.security === 'open' ? '🔓' : '🔒';
            option.value = JSON.stringify({
                ssid: network.ssid,
                security: network.security
            });
            option.textContent = `${securityIcon} ${network.ssid} ${network.signal}%`;
            
            if (network.connected) {
                option.textContent += ' (Connected)';
                option.style.fontWeight = 'bold';
                option.style.color = '#4CAF50';
            }
            
            wifiNetworksSelect.appendChild(option);
        });
    }
    
    
    async connectToSelectedNetwork() {
        const wifiNetworksSelect = document.getElementById('wifi-networks-select');
        const wifiPassword = document.getElementById('wifi-password');
        
        if (!wifiNetworksSelect || !wifiNetworksSelect.value) {
            alert('Please select a network to connect to');
            return;
        }
        
        try {
            const networkData = JSON.parse(wifiNetworksSelect.value);
            const password = wifiPassword ? wifiPassword.value.trim() : '';
            
            // For secured networks, require password unless user explicitly left it empty
            if (networkData.security === 'secured' && !password) {
                const confirmConnect = confirm(`Connect to secured network "${networkData.ssid}" without password? This will only work if the network doesn't require authentication.`);
                if (!confirmConnect) {
                    return;
                }
            }
            
            await this.performWifiConnection(networkData.ssid, password);
            
            // Clear password field after connection
            if (wifiPassword) {
                wifiPassword.value = '';
            }
        } catch (error) {
            alert('Invalid network selection');
            window.electronAPI.log.error('Failed to parse network data:', error);
        }
    }
    
    async performWifiConnection(ssid, password) {
        try {
            await window.electronAPI.invoke('connect-wifi', { ssid, password });
            
            // Update status after connection
            await this.updateWifiStatus();
            
            // Refresh the networks list to show current connection
            await this.refreshWifiNetworks();
            
            this.showMessage(`Connected to ${ssid} successfully!`);
        } catch (error) {
            window.electronAPI.log.error('Failed to connect to WiFi:', error);
            this.showMessage(`Failed to connect to ${ssid}: ${error.message}`);
        }
    }
    
    async disconnectWifi() {
        try {
            await window.electronAPI.invoke('disconnect-wifi');
            
            // Update status after disconnection
            await this.updateWifiStatus();
            
            // Refresh the networks list to update connection status
            await this.refreshWifiNetworks();
            
            this.showMessage('Disconnected from WiFi successfully!');
        } catch (error) {
            window.electronAPI.log.error('Failed to disconnect from WiFi:', error);
            this.showMessage(`Failed to disconnect: ${error.message}`);
        }
    }

    createUrlEntry(url = '', backgroundColor = '#000000', index = 0) {
        const urlsContainer = document.getElementById('urls-container');
        
        const urlEntry = document.createElement('div');
        urlEntry.className = 'url-entry';
        urlEntry.innerHTML = `
            <input type="text" placeholder="https://example.com" value="${url}" class="url-input">
            <input type="color" value="${backgroundColor}" class="color-input">
            <button type="button" class="remove-url-btn">×</button>
        `;

        // Add remove functionality
        const removeBtn = urlEntry.querySelector('.remove-url-btn');
        this.addEventListenerTracked(removeBtn, 'click', () => {
            urlEntry.remove();
        });

        urlsContainer.appendChild(urlEntry);
        return urlEntry;
    }

    addUrlEntry() {
        const urlsContainer = document.getElementById('urls-container');
        const entryCount = urlsContainer.children.length;
        this.createUrlEntry('', '#000000', entryCount);
    }

    async saveSettings() {
        const urlsContainer = document.getElementById('urls-container');
        const autoRotateCheck = document.getElementById('auto-rotate');
        const fullscreenCheck = document.getElementById('fullscreen');
        const rotateIntervalInput = document.getElementById('rotate-interval');
        const devToolsCheck = document.getElementById('dev-tools');
        const showMoonPhaseCheck = document.getElementById('show-moon-phase');
        const showWeatherCheck = document.getElementById('show-weather');
        const showUVCheck = document.getElementById('show-uv');
        const showTemperatureCheck = document.getElementById('show-temperature');
        const showHumidityCheck = document.getElementById('show-humidity');
        const timeFormatSelect = document.getElementById('time-format');
        const temperatureUnitSelect = document.getElementById('temperature-unit');
        const latitudeInput = document.getElementById('latitude');
        const longitudeInput = document.getElementById('longitude');
        const uvUpdateFrequencySelect = document.getElementById('uv-update-frequency');
        const screensaverUrlInput = document.getElementById('screensaver-url');
        const screensaverEnabledCheck = document.getElementById('screensaver-enabled');
        const useQuotesScreensaverCheck = document.getElementById('use-quotes-screensaver');
        const autostartEnabledCheck = document.getElementById('autostart-enabled');

        // Collect URLs and background colors
        const urlEntries = urlsContainer.querySelectorAll('.url-entry');
        const urlsData = [];

        for (const entry of urlEntries) {
            const urlInput = entry.querySelector('.url-input');
            const colorInput = entry.querySelector('.color-input');
            const url = urlInput.value.trim();
            
            if (url.length > 0) {
                // Validate URL format
                try {
                    new URL(url);
                } catch (e) {
                    alert(`Invalid URL: ${url}`);
                    return;
                }
                
                urlsData.push({
                    url: url,
                    backgroundColor: colorInput.value
                });
            }
        }

        if (urlsData.length === 0) {
            alert('Please enter at least one URL');
            return;
        }

        // Validate coordinates
        // Handle empty fields with defaults
        const latitudeValue = latitudeInput.value.trim();
        const longitudeValue = longitudeInput.value.trim();
        const rotateIntervalValue = rotateIntervalInput.value.trim();
        
        // Set defaults for empty fields and update input display
        const latitude = latitudeValue === '' ? 40.7128 : parseFloat(latitudeValue);
        const longitude = longitudeValue === '' ? -74.0060 : parseFloat(longitudeValue);
        const rotateInterval = rotateIntervalValue === '' ? 1 : parseInt(rotateIntervalValue);
        
        // Update the input fields to show the default values if they were empty
        if (latitudeValue === '') {
            latitudeInput.value = latitude.toString();
        }
        if (longitudeValue === '') {
            longitudeInput.value = longitude.toString();
        }
        if (rotateIntervalValue === '') {
            rotateIntervalInput.value = rotateInterval.toString();
        }
        
        if (isNaN(latitude) || latitude < -90 || latitude > 90) {
            alert('Please enter a valid latitude between -90 and 90');
            return;
        }
        
        if (isNaN(longitude) || longitude < -180 || longitude > 180) {
            alert('Please enter a valid longitude between -180 and 180');
            return;
        }

        // Determine screensaver URL
        let screensaverUrl;
        if (useQuotesScreensaverCheck.checked) {
            screensaverUrl = '@Quotes/index.html';
        } else {
            screensaverUrl = screensaverUrlInput.value.trim();
            // Validate screensaver URL if provided
            if (screensaverUrl && screensaverUrl.length > 0) {
                try {
                    new URL(screensaverUrl);
                } catch (e) {
                    alert(`Invalid Screensaver URL: ${screensaverUrl}`);
                    return;
                }
            }
        }

        // Create new config
        const newConfig = {
            urls: urlsData,
            autoRotate: autoRotateCheck.checked,
            autoRotateInterval: Math.max(1, Math.min(60, rotateInterval)) * 60000, // Clamp between 1-60 minutes
            fullscreen: fullscreenCheck.checked,
            enableDevTools: devToolsCheck.checked,
            showMoonPhase: showMoonPhaseCheck.checked,
            showWeather: showWeatherCheck.checked,
            showUV: showUVCheck.checked,
            showTemperature: showTemperatureCheck.checked,
            showHumidity: showHumidityCheck.checked,
            timeFormat: timeFormatSelect.value,
            temperatureUnit: temperatureUnitSelect.value,
            latitude: latitude,
            longitude: longitude,
            uvUpdateFrequency: parseInt(uvUpdateFrequencySelect.value),
            screensaverUrl: screensaverUrl || 'https://lodev09.github.io/web-screensavers/jellyfish/',
            screensaverEnabled: screensaverEnabledCheck.checked,
            comments: this.config.comments // Preserve comments
        };

        try {
            // Save config via IPC
            const result = await window.electronAPI.invoke('save-config', newConfig);
            
            if (result.success) {
                // Handle autostart toggle (Linux only)
                if (autostartEnabledCheck) {
                    try {
                        await window.electronAPI.invoke('set-autostart', autostartEnabledCheck.checked);
                        window.electronAPI.log.info('Autostart setting updated:', autostartEnabledCheck.checked);
                    } catch (autostartError) {
                        window.electronAPI.log.error('Failed to update autostart:', autostartError);
                        // Don't fail the entire save operation for autostart errors
                    }
                }
                
                // Update local config
                this.config = newConfig;
                
                // Close settings
                this.closeSettings();
                
                // Reload the app with new settings
                await this.reloadWithNewSettings();
                
                // Show success message
                this.showMessage('Settings saved and applied successfully!');
                window.electronAPI.log.info('Settings saved to:', result.path);
            } else {
                window.electronAPI.log.error('Failed to save settings:', result.error);
                alert(`Failed to save settings: ${result.details || result.error}`);
            }
            
        } catch (error) {
            window.electronAPI.log.error('Failed to save settings:', error);
            alert('Failed to save settings. Please check the logs for details.');
        }
    }

    async reloadWithNewSettings() {
        try {
            // Clean up timers before reloading
            this.cleanup();
            
            // Re-establish essential IPC listeners that were removed by cleanup
            this.addIpcListener('view-changed', ({ index, url, backgroundColor }) => {
                this.currentIndex = index;
                this.updateUI();
                if (backgroundColor) {
                    this.applyBackgroundColor(backgroundColor);
                }
            });
            
            // Tell main process to reload with new config
            await window.electronAPI.invoke('reload-with-new-config');
            
            // Update indicators for new URLs
            this.createIndicators();
            
            // Note: currentIndex will be updated by the view-changed event from main process
            // Don't reset currentIndex here - let main process maintain it
            
            // Restart auto-rotate if enabled
            if (this.config.autoRotate) {
                this.startAutoRotate();
            }
            
            // Update moon phase visibility and restart timer
            await this.setupMoonPhase();
            this.startMoonPhaseTimer();
            
            // Restart weather timer
            await this.setupWeatherData();
            this.startWeatherTimer();
            
            // Restart UV timer
            await this.setupUVData();
            this.startUVTimer();
            
            // Re-setup Bitcoin history
            await this.setupBitcoinHistory();
            this.startBitcoinHistoryTimer();
            
            // Update screensaver button visibility
            this.updateScreensaverButtonVisibility();
            
            // Re-setup all event listeners that were cleaned up
            this.setupNavigation();
            this.setupGestures();
            this.setupErrorHandling();
            this.setupSettings();
            this.setupVirtualKeyboard();
            this.setupScreensaver();
            this.setupExitButton();
            this.setupUVClickHandler();
            this.setupBitcoinHistoryClickHandler();
            this.setupTemperatureClickHandler();
            
        } catch (error) {
            window.electronAPI.log.error('Failed to reload with new settings:', error);
        }
    }

    showMessage(message) {
        // Create a temporary message overlay
        const messageDiv = document.createElement('div');
        messageDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 20px 30px;
            border-radius: 15px;
            font-size: 16px;
            z-index: 25000;
            backdrop-filter: blur(10px);
            animation: fadeIn 0.3s ease-out;
        `;
        messageDiv.textContent = message;
        document.body.appendChild(messageDiv);

        // Remove after 3 seconds
        setTimeout(() => {
            messageDiv.style.animation = 'fadeOut 0.3s ease-out';
            setTimeout(() => {
                document.body.removeChild(messageDiv);
            }, 300);
        }, 3000);
    }

    async goToSlide(index) {
        if (this.isTransitioning || index === this.currentIndex) return;
        
        this.isTransitioning = true;
        
        try {
            await window.electronAPI.invoke('go-to-slide', index);
        } catch (error) {
            window.electronAPI.log.error('Failed to go to slide:', error);
        }

        // Reset transition flag
        setTimeout(() => {
            this.isTransitioning = false;
        }, 400);
    }

    async nextSlide() {
        if (this.isTransitioning) return;
        
        try {
            await window.electronAPI.invoke('next-slide');
        } catch (error) {
            window.electronAPI.log.error('Failed to go to next slide:', error);
        }
    }

    async previousSlide() {
        if (this.isTransitioning) return;
        
        try {
            await window.electronAPI.invoke('previous-slide');
        } catch (error) {
            window.electronAPI.log.error('Failed to go to previous slide:', error);
        }
    }


    startAutoRotate() {
        if (!this.config.autoRotate || !this.config.autoRotateInterval || this.config.autoRotateInterval <= 0) return;

        this.resetAutoRotate();
    }

    pauseAutoRotate() {
        // Store the current state to resume later
        this.autoRotatePaused = true;
        
        // Clear existing timers
        if (this.autoRotateTimer) {
            clearTimeout(this.autoRotateTimer);
            this.autoRotateTimer = null;
        }
        if (this.autoRotateCountdown) {
            clearInterval(this.autoRotateCountdown);
            this.autoRotateCountdown = null;
        }
    }

    resumeAutoRotate() {
        if (this.autoRotatePaused && this.config.autoRotate) {
            this.autoRotatePaused = false;
            this.resetAutoRotate();
        }
    }

    resetAutoRotate() {
        // Clear existing timers
        if (this.autoRotateTimer) {
            clearTimeout(this.autoRotateTimer);
        }
        if (this.autoRotateCountdown) {
            clearInterval(this.autoRotateCountdown);
        }

        if (!this.config.autoRotate || !this.config.autoRotateInterval || this.config.autoRotateInterval <= 0) return;

        // Start countdown display
        let timeLeft = this.config.autoRotateInterval / 1000;
        
        this.autoRotateCountdown = setInterval(() => {
            timeLeft--;
            
            if (timeLeft <= 0) {
                clearInterval(this.autoRotateCountdown);
            }
        }, 1000);

        // Set auto-rotate timer
        this.autoRotateTimer = setTimeout(() => {
            this.nextSlide();
        }, this.config.autoRotateInterval);
    }


    showError(message) {
        const errorOverlay = document.getElementById('error-overlay');
        const errorMessage = document.getElementById('error-message');
        
        errorMessage.textContent = message;
        errorOverlay.classList.remove('hidden');
    }

    hideError() {
        const errorOverlay = document.getElementById('error-overlay');
        errorOverlay.classList.add('hidden');
    }

    async retryCurrentSlide() {
        try {
            await window.electronAPI.invoke('reload-current-slide');
        } catch (error) {
            window.electronAPI.log.error('Failed to reload current slide:', error);
        }
        this.hideError();
    }

    hideLoadingScreen() {
        const loadingScreen = document.getElementById('loading-screen');
        const mainContent = document.getElementById('main-content');
        
        setTimeout(() => {
            loadingScreen.style.opacity = '0';
            setTimeout(() => {
                loadingScreen.style.display = 'none';
                mainContent.classList.remove('hidden');
                mainContent.classList.add('fade-in');
            }, 500);
        }, 1000);
    }

    // Show/hide UI elements on mouse movement
    setupUIVisibility() {
        let hideTimer;
        const uiElements = [
            document.querySelector('.nav-indicators')
        ];

        const showUI = () => {
            uiElements.forEach(el => {
                if (el) el.classList.add('show');
            });
            
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                uiElements.forEach(el => {
                    if (el) el.classList.remove('show');
                });
            }, 3000);
        };

        this.addEventListenerTracked(document, 'mousemove', showUI);
        this.addEventListenerTracked(document, 'touchstart', showUI);
    }

    applyBackgroundColor(backgroundColor) {
        // Apply background color to multiple elements to ensure it shows
        document.body.style.backgroundColor = backgroundColor;
        document.documentElement.style.backgroundColor = backgroundColor;
        
        const contentContainer = document.querySelector('.content-container');
        if (contentContainer) {
            contentContainer.style.backgroundColor = backgroundColor;
        }
        
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            appContainer.style.backgroundColor = backgroundColor;
        }
        
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            mainContent.style.backgroundColor = backgroundColor;
        }
    }
}

// Global instance for cleanup
let digitalSignageInstance = null;

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    digitalSignageInstance = new DigitalSignage();
});

// Clean up before page unload
window.addEventListener('beforeunload', () => {
    if (digitalSignageInstance) {
        digitalSignageInstance.cleanup();
    }
});

// Handle app-specific IPC events
window.electronAPI.on('reload-config', async () => {
    try {
        // Clean up before reload
        if (digitalSignageInstance) {
            digitalSignageInstance.cleanup();
        }
        
        const newConfig = await window.electronAPI.invoke('reload-config');
        location.reload(); // Reload the renderer to apply new config
    } catch (error) {
        window.electronAPI.log.error('Failed to reload config:', error);
    }
});
