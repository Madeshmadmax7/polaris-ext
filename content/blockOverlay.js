/**
 * LifeOS – Block Overlay (Strict Distraction-Only)
 * Uses Shadow DOM + MutationObserver for maximum reliability.
 * 
 * BLOCKING RULES:
 * - YouTube watch pages: Block ONLY if yt_current_classification === 'distracting'
 * - YouTube home/search: Never auto-block (unless manually/parentally blocked)
 * - Non-YouTube distracting sites: Block if site_auto_classification === 'distracting'
 * - Manually/parentally blocked sites: Always block (blocking_rules_map)
 * - EVERYTHING ELSE: Allow
 */

console.log('[LifeOS] blockOverlay.js ENTRY');
(() => {
    let shadowContainer = null;
    let shadowRoot = null;
    let protectionObserver = null;
    let checkInterval = null;

    console.log('[LifeOS] blockOverlay.js SETUP');

    /**
     * Normalize domain for comparison.
     */
    function normalize(domain) {
        return (domain || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    }

    /**
     * Safety check for extension context.
     */
    function isContextValid() {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            console.log('[LifeOS] Context invalidated. Stopping overlay.');
            stopAll();
            return false;
        }
        return true;
    }

    /**
     * Stop all listeners and intervals.
     */
    function stopAll() {
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        try {
            chrome.storage.onChanged.removeListener(onStorageChange);
            chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        } catch (e) { }
        removeOverlay();
    }

    /**
     * Check if the current domain should be blocked.
     * STRICT RULES: Only block when definitively classified as distracting.
     */
    async function checkBlock() {
        if (!isContextValid()) return;

        try {
            const storage = await chrome.storage.local.get([
                'blocking_rules_map',
                'yt_current_classification',
                'site_auto_classification'
            ]);
            const ruleMap = storage.blocking_rules_map || {};
            const ytClass = storage.yt_current_classification || 'none';
            const siteAutoClass = storage.site_auto_classification || 'none';
            const currentHost = normalize(window.location.hostname);
            const currentPath = window.location.pathname;

            // 1. Check manual/parental blocks (blocking_rules_map)
            const isBlockedManually = Object.keys(ruleMap).some(domain => {
                const normDomain = normalize(domain);
                return currentHost === normDomain || currentHost.endsWith('.' + normDomain);
            });

            let finalBlocked = isBlockedManually;

            // 2. YouTube-specific logic
            if (currentHost.includes('youtube.com')) {
                const isWatchPage = currentPath.startsWith('/watch') || window.location.search.includes('v=');
                const isSearchPage = currentPath.startsWith('/results') || currentPath.startsWith('/search');

                if (isWatchPage && !isSearchPage) {
                    // STRICT: Only block if definitively classified as 'distracting'
                    if (ytClass === 'distracting') {
                        console.log('[LifeOS] Blocking distracting YouTube video');
                        finalBlocked = true;
                    } else if (ytClass === 'productive') {
                        console.log('[LifeOS] Allowing productive YouTube video');
                        finalBlocked = false; // Override even manual blocks for productive videos
                    } else {
                        // Classification is 'pending' or 'none' — DO NOT BLOCK
                        // Wait for youtubeTracker to classify
                        console.log(`[LifeOS] YouTube classification pending (${ytClass}), allowing playback`);
                        finalBlocked = false;
                    }
                } else if (isSearchPage || currentPath === '/') {
                    // YouTube home/search — don't auto-block unless manually blocked
                    // Keep finalBlocked as isBlockedManually
                }
            } else {
                // 3. Non-YouTube sites: block if auto-classified as distracting
                if (siteAutoClass === 'distracting') {
                    console.log(`[LifeOS] Auto-blocking distracting site: ${currentHost}`);
                    finalBlocked = true;
                }
            }

            if (finalBlocked) {
                injectOverlay();
            } else {
                removeOverlay();
            }
        } catch (e) {
            if (e.message?.includes('context invalidated')) {
                stopAll();
            } else {
                console.error('[LifeOS] Error in checkBlock:', e);
            }
        }
    }

    /**
     * Inject the LifeOS themed overlay using Shadow DOM.
     */
    function injectOverlay() {
        if (shadowContainer) {
            if (!document.documentElement.contains(shadowContainer)) {
                console.log('[LifeOS] Re-attaching overlay...');
                document.documentElement.appendChild(shadowContainer);
            }
            return;
        }

        console.log('[LifeOS] Injecting overlay...');

        // 1. Create and Style Container
        shadowContainer = document.createElement('div');
        shadowContainer.id = 'lifeos-portal';
        shadowContainer.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: 2147483647 !important;
            pointer-events: all !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;

        // 2. Attach Shadow Root
        shadowRoot = shadowContainer.attachShadow({ mode: 'open' });

        // 3. Create UI
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            width: 100vw;
            height: 100vh;
            background: #0a0a1a;
            background-image: radial-gradient(circle at center, #1a1a3a 0%, #0a0a1a 100%);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            color: #ffffff;
            font-family: system-ui, -apple-system, sans-serif;
            text-align: center;
        `;

        const isYT = window.location.hostname.includes('youtube.com');

        overlay.innerHTML = `
            <div style="background: rgba(255,255,255,0.05); padding: 50px; border-radius: 40px; border: 1px solid rgba(124, 92, 255, 0.2); box-shadow: 0 20px 80px rgba(0,0,0,0.8); max-width: 90%;">
                <div style="font-size: 80px; margin-bottom: 20px;">🛡️</div>
                <h1 style="font-size: 32px; color: #7c5cff; margin: 0 0 16px;">Focus Mode Active</h1>
                <p style="font-size: 18px; color: #ccccff; margin: 0 0 32px; line-height: 1.6;">
                    ${isYT ? 'This video is classified as distracting.' : 'This site is classified as distracting.'} <br>
                    Take a breath and get back to what matters.
                </p>
                <button id="backBtn" style="background: #7c5cff; color: white; border: none; padding: 18px 40px; border-radius: 20px; font-weight: 800; font-size: 18px; cursor: pointer; transition: transform 0.2s;">
                    ${isYT ? 'Back to YouTube Home' : 'Go Back to Work'}
                </button>
            </div>
        `;

        shadowRoot.appendChild(overlay);
        document.documentElement.appendChild(shadowContainer);

        shadowRoot.getElementById('backBtn').onclick = () => {
            if (isYT) {
                window.location.href = 'https://www.youtube.com/';
            } else if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.href = 'http://127.0.0.1:5173/';
            }
        };

        // 4. Video Pausing Loop
        const pauseInterval = setInterval(() => {
            if (!shadowContainer) {
                clearInterval(pauseInterval);
                return;
            }
            document.querySelectorAll('video').forEach(v => {
                try { if (!v.paused) v.pause(); } catch (e) { }
            });
        }, 500);

        // 5. Anti-Removal Protection
        if (!protectionObserver) {
            protectionObserver = new MutationObserver((mutations) => {
                for (let mutation of mutations) {
                    for (let removedNode of mutation.removedNodes) {
                        if (removedNode === shadowContainer) {
                            console.log('[LifeOS] Protection: Re-injecting overlay...');
                            document.documentElement.appendChild(shadowContainer);
                        }
                    }
                }
            });
            protectionObserver.observe(document.documentElement, { childList: true });
        }

        // 6. Disable Scrolling
        document.documentElement.style.overflow = 'hidden';
        if (document.body) document.body.style.overflow = 'hidden';
    }

    /**
     * Remove the overlay.
     */
    function removeOverlay() {
        if (shadowContainer) {
            if (protectionObserver) {
                protectionObserver.disconnect();
                protectionObserver = null;
            }
            shadowContainer.remove();
            shadowContainer = null;
            shadowRoot = null;
            document.documentElement.style.overflow = '';
            if (document.body) document.body.style.overflow = '';
        }
    }

    function onStorageChange(changes) {
        if (changes.blocking_rules_map || changes.yt_current_classification || changes.site_auto_classification) {
            checkBlock();
        }
    }

    function onRuntimeMessage(message) {
        if (message.type === 'CHECK_BLOCK') {
            checkBlock();
        }
    }

    // Storage listener
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(onStorageChange);
        }
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener(onRuntimeMessage);
        }
    } catch (e) {
        if (e.message?.includes('context invalidated')) stopAll();
    }

    // YouTube SPA Support
    if (window.location.hostname.includes('youtube.com')) {
        window.addEventListener('yt-navigate-finish', () => {
            console.log('[LifeOS] YT Navigate - checking block');
            checkBlock();
        });
    }

    // Initial check
    checkBlock();

    // Periodic fallback check every 2 seconds (for edge cases only)
    checkInterval = setInterval(() => {
        checkBlock();
    }, 2000);

    console.log('[LifeOS] Overlay Running (strict distraction-only mode)');
})();
