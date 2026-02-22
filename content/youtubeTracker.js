/**
 * LifeOS – YouTube Video Tracker (Content Script)
 * Runs ONLY on youtube.com pages.
 * 
 * Extracts video title and classifies it as learning vs entertainment
 * using keyword matching. Sends classification to background script.
 * 
 * Handles YouTube's SPA navigation (no full page reloads).
 */

(() => {
    // ── Learning Keywords ────────────────────────────────────
    const LEARNING_KEYWORDS = [
        // General education
        'tutorial', 'course', 'lecture', 'learn', 'learning', 'how to', 'explained',
        'walkthrough', 'study', 'education', 'class', 'lesson', 'training',
        'guide', 'documentation', 'workshop', 'bootcamp', 'masterclass',
        // CS / Programming
        'programming', 'coding', 'code', 'developer', 'software', 'web dev',
        'javascript', 'python', 'java', 'react', 'node', 'sql', 'database',
        'algorithm', 'data structure', 'dsa', 'leetcode', 'competitive',
        'frontend', 'backend', 'fullstack', 'full stack', 'api', 'devops',
        'git', 'linux', 'docker', 'kubernetes', 'cloud', 'aws', 'azure',
        'typescript', 'c++', 'golang', 'rust', 'flutter', 'swift',
        'react native', 'angular', 'vue', 'django', 'flask', 'spring boot',
        'machine learning', 'deep learning', 'artificial intelligence',
        'neural network', 'nlp', 'computer vision', 'tensorflow', 'pytorch',
        // Science & Math
        'physics', 'chemistry', 'biology', 'math', 'calculus', 'algebra',
        'statistics', 'probability', 'engineering', 'science',
        // Academic
        'exam', 'preparation', 'syllabus', 'gate', 'placement',
        'interview prep', 'campus', 'semester', 'university', 'college',
        // Professional
        'portfolio', 'resume', 'career', 'freelance', 'project', 'showcase',
        // Tech news (if requested, but usually learning-adjacent)
        'mkbhd', 'technology', 'tech news', 'future of', 'review', 'hands-on',
        'unboxing', 'comparison', 'specifications',
    ];

    let lastVideoId = null;
    let lastTitle = null;
    let trackingInterval = null;
    let titleObserver = null;

    /**
     * Safety check for extension context.
     */
    function isContextValid() {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            stopAll();
            return false;
        }
        return true;
    }

    /**
     * Stop all activities.
     */
    function stopAll() {
        if (trackingInterval) clearInterval(trackingInterval);
        if (titleObserver) titleObserver.disconnect();
        console.log('[LifeOS] YouTube tracker disabled - context invalidated. PLEASE REFRESH PAGE.');
    }

    /**
     * Extract video title from the YouTube page.
     */
    function getVideoTitle() {
        // Method 1: New UI (ytd-watch-metadata)
        const h1 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
        if (h1 && h1.innerText) return h1.innerText.trim();

        // Method 2: Old UI (ytd-video-primary-info-renderer)
        const titleContainer = document.querySelector('ytd-video-primary-info-renderer h1.title yt-formatted-string');
        if (titleContainer && titleContainer.innerText) return titleContainer.innerText.trim();

        // Method 3: Meta tag (most reliable even during SPA nav)
        const metaTitle = document.querySelector('meta[name="title"]');
        if (metaTitle && metaTitle.content) {
            return metaTitle.content.trim();
        }

        // Method 4: Document title (fallback, includes " - YouTube" suffix)
        const docTitle = document.title;
        if (docTitle && docTitle !== 'YouTube') {
            return docTitle.replace(/\s*-\s*YouTube\s*$/, '').trim();
        }

        return null;
    }

    /**
     * Extract video ID from URL.
     */
    function getVideoId() {
        const params = new URLSearchParams(window.location.search);
        return params.get('v') || null;
    }

    /**
     * Classify video title as 'productive' or 'distracting'.
     */
    function classifyVideo(title) {
        if (!title) return 'distracting';

        const lowerTitle = title.toLowerCase();

        for (const keyword of LEARNING_KEYWORDS) {
            if (lowerTitle.includes(keyword)) {
                return 'productive';
            }
        }

        return 'distracting';
    }

    /**
     * Send video info to background script.
     */
    function reportVideoInfo() {
        if (!isContextValid()) return;
        const videoId = getVideoId();

        // Only process watch pages
        if (!videoId || !window.location.pathname.startsWith('/watch')) {
            return;
        }

        const title = getVideoTitle();

        // Skip if same video already reported
        if (videoId === lastVideoId && title === lastTitle) {
            return;
        }

        lastVideoId = videoId;
        lastTitle = title;

        const classification = classifyVideo(title);

        console.log(`[LifeOS YT] "${title}" → ${classification}`);

        try {
            chrome.runtime.sendMessage({
                type: 'YOUTUBE_VIDEO_INFO',
                data: {
                    title: title,
                    videoId: videoId,
                    classification: classification,
                },
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[LifeOS YT] Message failed:', chrome.runtime.lastError.message);
                }
            });
        } catch (e) {
            // Extension context invalidated
            console.debug('[LifeOS YT] Send failed:', e.message);
        }
    }

    /**
     * Redirect YouTube Shorts to main YouTube page.
     */
    function checkShortsRedirect() {
        if (window.location.pathname.startsWith('/shorts/')) {
            console.log('[LifeOS YT] Redirecting from Shorts to main page');
            window.location.href = 'https://www.youtube.com/';
        }
    }

    // ── Initial check ────────────────────────────────────────
    checkShortsRedirect();
    // Wait a moment for the page to fully render
    setTimeout(reportVideoInfo, 200);

    // ── Periodic re-report ──
    trackingInterval = setInterval(() => {
        if (!isContextValid()) return;
        if (window.location.pathname.startsWith('/watch')) {
            const title = getVideoTitle();
            const videoId = getVideoId();
            if (title && videoId) {
                try {
                    chrome.runtime.sendMessage({
                        type: 'YOUTUBE_VIDEO_INFO',
                        data: { title, videoId, classification: classifyVideo(title) },
                    }, () => { if (chrome.runtime.lastError) { } });
                } catch (e) { }
            }
        }
    }, 3000);

    // ── YouTube SPA Navigation ───────────────────────────────
    window.addEventListener('yt-navigate-finish', () => {
        if (!isContextValid()) return;
        checkShortsRedirect();

        // Clear previous video's classification
        chrome.storage.local.set({ 'yt_current_classification': 'pending' });

        // Reset last video so the new one gets reported
        lastVideoId = null;
        lastTitle = null;
        // Small delay to let the new page title settle
        setTimeout(reportVideoInfo, 300);
    });

    // ── Fallback: Title mutation observer ────────────────────
    titleObserver = new MutationObserver(() => {
        if (!isContextValid()) return;
        checkShortsRedirect();
        if (window.location.pathname.startsWith('/watch')) {
            setTimeout(reportVideoInfo, 200);
        }
    });

    titleObserver.observe(
        document.querySelector('title') || document.head,
        { childList: true, subtree: true, characterData: true }
    );

    console.log('[LifeOS] YouTube tracker loaded');
})();
