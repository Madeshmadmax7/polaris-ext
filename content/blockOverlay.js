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
    let lastBlockState = null; // Track state to reduce log noise

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
                    // Block if classified as 'distracting'
                    if (ytClass === 'distracting') {
                        if (lastBlockState !== 'yt_blocked') {
                            console.log('[LifeOS] Blocking distracting YouTube video');
                            lastBlockState = 'yt_blocked';
                        }
                        finalBlocked = true;
                    } else if (ytClass === 'productive') {
                        if (lastBlockState !== 'yt_allowed') {
                            console.log('[LifeOS] Allowing productive YouTube video');
                            lastBlockState = 'yt_allowed';
                        }
                        finalBlocked = false; // Override even manual blocks for productive videos
                    }
                    // If 'pending' or 'none', don't change finalBlocked (keep manual block status)
                    // The periodic check will pick it up once classified
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
            <div style="background: rgba(255,255,255,0.05); padding: 60px; border-radius: 40px; border: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(20px); box-shadow: 0 40px 100px rgba(0,0,0,0.8); max-width: 90%;">
                <div style="margin-bottom: 30px; opacity: 0.9;">
                    <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                    </svg>
                </div>
                <h1 style="font-size: 32px; font-weight: 700; color: #fff; margin: 0 0 24px; letter-spacing: -0.02em;">Focus Mode Active</h1>
                <p style="font-size: 18px; color: rgba(255,255,255,0.6); margin: 0 0 40px; line-height: 1.8;">
                    ${isYT ? 'This video is classified as distracting.' : 'This site is classified as distracting.'} <br>
                    Redirect your energy towards your goals.
                </p>
                <button id="backBtn" style="background: #fff; color: #000; border: none; padding: 20px 48px; border-radius: 30px; font-weight: 700; font-size: 16px; cursor: pointer; transition: all 0.3s; text-transform: uppercase; letter-spacing: 0.1em;">
                    ${isYT ? 'RETURN TO HOME' : 'GO BACK TO WORK'}
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
            // Small delay to let youtubeTracker classify first
            setTimeout(checkBlock, 100);
        });
    }

    // Initial check - immediate for all sites
    checkBlock();

    // Periodic fallback check every 1 second for fast blocking response
    checkInterval = setInterval(() => {
        checkBlock();
    }, 1000); // 1 second for faster blocking detection

    console.log('[LifeOS] Overlay Running (strict distraction-only mode)');
})();
