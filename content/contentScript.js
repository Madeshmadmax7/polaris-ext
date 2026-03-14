/**
 * LifeOS – Content Script
 * Communicates with background.js using chrome.runtime.sendMessage()
 * with retry-on-failure, acknowledgment response, and timeout handling.
 * Prevents silent message drops.
 */

(() => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;
    const MESSAGE_TIMEOUT = 5000;

    /**
     * Safety check for extension context.
     * Prevents "Extension context invalidated" errors.
     */
    function isContextValid() {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            console.log('[LifeOS] Context invalidated. Detaching listeners.');
            stopAll();
            return false;
        }
        return true;
    }

    function stopAll() {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('message', handleWindowMessage);
    }

    /**
     * Send message to background with retry and acknowledgment.
     * @param {Object} message 
     * @param {number} retries 
     * @returns {Promise<Object>}
     */
    function sendMessageWithRetry(message, retries = MAX_RETRIES) {
        return new Promise((resolve, reject) => {
            if (!isContextValid()) {
                reject(new Error('Extension context invalidated'));
                return;
            }

            let attempt = 0;
            // ... (rest of sendMessageWithRetry) ...
            function trySend() {
                attempt++;

                // Timeout wrapper
                const timeoutId = setTimeout(() => {
                    if (attempt < retries) {
                        console.log(`[CS] Retry ${attempt}/${retries}: ${message.type}`);
                        setTimeout(trySend, RETRY_DELAY * attempt);
                    } else {
                        reject(new Error(`Message timeout after ${retries} attempts`));
                    }
                }, MESSAGE_TIMEOUT);

                try {
                    if (!isContextValid()) {
                        clearTimeout(timeoutId);
                        reject(new Error('Context invalidated during send attempt'));
                        return;
                    }
                    chrome.runtime.sendMessage(message, (response) => {
                        clearTimeout(timeoutId);

                        if (chrome.runtime.lastError) {
                            console.warn('[CS] Message error:', chrome.runtime.lastError.message);
                            if (attempt < retries) {
                                setTimeout(trySend, RETRY_DELAY * attempt);
                            } else {
                                reject(new Error(chrome.runtime.lastError.message));
                            }
                            return;
                        }

                        // Check acknowledgment
                        if (response && response.ack) {
                            resolve(response);
                        } else if (attempt < retries) {
                            setTimeout(trySend, RETRY_DELAY * attempt);
                        } else {
                            reject(new Error('No acknowledgment received'));
                        }
                    });
                } catch (error) {
                    clearTimeout(timeoutId);
                    if (error.message?.includes('context invalidated')) {
                        stopAll();
                        reject(error);
                    } else if (attempt < retries) {
                        setTimeout(trySend, RETRY_DELAY * attempt);
                    } else {
                        reject(error);
                    }
                }
            }

            trySend();
        });
    }

    // ── Page Visibility Tracking ──────────────────────────
    function handleVisibilityChange() {
        sendMessageWithRetry({
            type: 'FOCUS_UPDATE',
            data: {
                visible: !document.hidden,
                timestamp: new Date().toISOString(),
            },
        }).catch(err => {
            // Non-critical, don't crash
            console.debug('[CS] Focus update failed:', err.message);
        });
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // ── Expose status query for popup ─────────────────────
    function handleWindowMessage(event) {
        if (event.data && event.data.type === 'POLARIS_STATUS_REQUEST') {
            sendMessageWithRetry({ type: 'GET_STATUS' })
                .then(response => {
                    if (isContextValid()) {
                        window.postMessage({
                            type: 'POLARIS_STATUS_RESPONSE',
                            data: response.data,
                        }, '*');
                    }
                })
                .catch(() => { });
        } else if (event.data && event.data.type === 'POLARIS_SET_MODE') {
            sendMessageWithRetry({
                type: 'UPDATE_SETTING',
                data: { key: 'blocking_mode', value: event.data.mode }
            }).catch(() => { });
        } else if (event.data && event.data.type === 'POLARIS_SET_PENDING_CHAPTER') {
            // Frontend tells extension which chapter the user is searching a video for
            console.log('[CS] Pending chapter set:', event.data.data);
            sendMessageWithRetry({
                type: 'SET_PENDING_CHAPTER',
                data: event.data.data
            }).then(() => {
                window.postMessage({ type: 'POLARIS_PENDING_CHAPTER_ACK' }, '*');
            }).catch(() => { });
        }
    }
    window.addEventListener('message', handleWindowMessage);

    console.log('[LifeOS] Content script loaded');
})();
