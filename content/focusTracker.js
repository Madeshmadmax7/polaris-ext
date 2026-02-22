/**
 * LifeOS – Focus Tracker (Content Script)
 * Tracks focus session duration and tab engagement.
 * Reports visibility and focus changes to background.
 */

(() => {
    let isFocused = document.hasFocus();
    let isVisible = !document.hidden;
    let focusStartTime = isFocused ? Date.now() : null;

    function reportFocusState() {
        const currentlyActive = isFocused && isVisible;

        try {
            chrome.runtime.sendMessage({
                type: 'FOCUS_UPDATE',
                data: {
                    is_focused: isFocused,
                    is_visible: isVisible,
                    is_active: currentlyActive,
                    focus_duration_ms: focusStartTime
                        ? Date.now() - focusStartTime
                        : 0,
                    timestamp: new Date().toISOString(),
                },
            }, (response) => {
                if (chrome.runtime.lastError) {
                    // Silently ignore
                }
            });
        } catch (e) {
            // Extension context invalidated
        }
    }

    // Window focus events
    window.addEventListener('focus', () => {
        isFocused = true;
        if (!focusStartTime) {
            focusStartTime = Date.now();
        }
        reportFocusState();
    });

    window.addEventListener('blur', () => {
        isFocused = false;
        reportFocusState();
        focusStartTime = null;
    });

    // Page visibility API
    document.addEventListener('visibilitychange', () => {
        isVisible = !document.hidden;
        if (isVisible && !focusStartTime) {
            focusStartTime = Date.now();
        } else if (!isVisible) {
            focusStartTime = null;
        }
        reportFocusState();
    });

    // Periodic check (catches edge cases)
    setInterval(() => {
        const currentFocus = document.hasFocus();
        const currentVisible = !document.hidden;

        if (currentFocus !== isFocused || currentVisible !== isVisible) {
            isFocused = currentFocus;
            isVisible = currentVisible;
            reportFocusState();
        }
    }, 3000); // Every 3 seconds
})();
