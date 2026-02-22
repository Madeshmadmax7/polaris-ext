/**
 * LifeOS – Scroll Tracker (Content Script)
 * Tracks scroll depth and velocity for engagement metrics.
 * Reports to background script.
 */

(() => {
    let maxScrollDepth = 0;
    let lastScrollY = 0;
    let scrollVelocityAccum = 0;
    let scrollEventCount = 0;
    let reportInterval = null;

    function calculateScrollDepth() {
        const docHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            1
        );
        const viewportHeight = window.innerHeight;
        const scrollY = window.scrollY;

        // Scroll depth as percentage (0-1)
        const depth = (scrollY + viewportHeight) / docHeight;
        return Math.min(depth, 1.0);
    }

    function handleScroll() {
        const currentDepth = calculateScrollDepth();
        maxScrollDepth = Math.max(maxScrollDepth, currentDepth);

        // Calculate scroll velocity
        const currentScrollY = window.scrollY;
        const delta = Math.abs(currentScrollY - lastScrollY);
        scrollVelocityAccum += delta;
        scrollEventCount++;
        lastScrollY = currentScrollY;
    }

    function reportScrollData() {
        if (maxScrollDepth <= 0) return;

        const avgVelocity = scrollEventCount > 0
            ? scrollVelocityAccum / scrollEventCount
            : 0;

        try {
            chrome.runtime.sendMessage({
                type: 'SCROLL_UPDATE',
                data: {
                    scroll_depth: Math.round(maxScrollDepth * 100) / 100,
                    scroll_velocity: Math.round(avgVelocity),
                    timestamp: new Date().toISOString(),
                },
            }, (response) => {
                if (chrome.runtime.lastError) {
                    // Silently ignore — non-critical data
                }
            });
        } catch (e) {
            // Extension context may be invalidated
        }

        // Reset accumulators
        scrollVelocityAccum = 0;
        scrollEventCount = 0;
    }

    // Throttled scroll listener
    let scrollTimeout = null;
    window.addEventListener('scroll', () => {
        if (scrollTimeout) return;
        scrollTimeout = setTimeout(() => {
            handleScroll();
            scrollTimeout = null;
        }, 200); // Throttle to 5 events/sec max
    }, { passive: true });

    // Report every 30 seconds
    reportInterval = setInterval(reportScrollData, 30000);

    // Report when user navigates away (pagehide replaces deprecated unload/beforeunload)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            reportScrollData();
        }
    });

    window.addEventListener('pagehide', () => {
        reportScrollData();
        if (reportInterval) clearInterval(reportInterval);
    });
})();
