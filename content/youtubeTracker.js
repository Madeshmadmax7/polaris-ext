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
    let lastChannelName = null; // Current video's channel - retried until found
    let trackingInterval = null;
    let titleObserver = null;
    let videoDuration = 0;
    let currentChapterMatch = null;
    let progressTrackingInterval = null;
    let channelRetryInterval = null; // Retry until channel name is found
    let delayedReportVideoId = null; // Guard: only one 3s delayed block per video

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
        stopProgressTracking();
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
     * Check if a YouTube ad is currently playing.
     * During ads, video.duration and .ytp-time-duration show AD duration, not the real video.
     */
    function isAdPlaying() {
        try {
            const player = document.querySelector('#movie_player');
            return player && (
                player.classList.contains('ad-showing') ||
                player.classList.contains('ad-interrupting')
            );
        } catch (e) {
            return false;
        }
    }

    /**
     * Get video duration in seconds from YouTube player.
     * Returns 0 if an ad is playing (to avoid capturing ad duration as video duration).
     */
    function getVideoDuration() {
        try {
            // CRITICAL: During ads, both video.duration and .ytp-time-duration show AD length
            if (isAdPlaying()) return 0;

            // Method 1: Parse from duration text element (most reliable for main video)
            const durationElement = document.querySelector('.ytp-time-duration');
            if (durationElement && durationElement.textContent) {
                const parsed = parseDurationText(durationElement.textContent);
                if (parsed > 0) return parsed;
            }

            // Method 2: video element duration
            const videoElement = document.querySelector('video.html5-main-video') || document.querySelector('video');
            if (videoElement && videoElement.duration && !isNaN(videoElement.duration) && isFinite(videoElement.duration)) {
                return Math.floor(videoElement.duration);
            }

            return 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Wait for a valid video duration (handles ads, slow metadata loading).
     * Checks every 2 seconds until duration > 0 or maxWaitMs exceeded.
     */
    function waitForValidDuration(maxWaitMs) {
        return new Promise((resolve) => {
            const dur = getVideoDuration();
            if (dur > 0) { resolve(dur); return; }
            const start = Date.now();
            const check = setInterval(() => {
                const d = getVideoDuration();
                if (d > 0) {
                    clearInterval(check);
                    resolve(d);
                } else if (Date.now() - start > maxWaitMs) {
                    clearInterval(check);
                    console.log(`[LifeOS YT] Duration wait timed out after ${maxWaitMs / 1000}s`);
                    resolve(0);
                }
            }, 2000);
        });
    }

    /**
     * Parse duration text like "13:45" or "1:23:45" to seconds.
     */
    function parseDurationText(text) {
        try {
            const parts = text.trim().split(':').map(p => parseInt(p) || 0);
            if (parts.length === 2) {
                // MM:SS
                return parts[0] * 60 + parts[1];
            } else if (parts.length === 3) {
                // HH:MM:SS
                return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            return 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Get channel/creator name from YouTube page.
     */
    function getChannelName() {
        try {
            // Method 1: New UI
            const channelLink = document.querySelector('ytd-channel-name a');
            if (channelLink) return channelLink.textContent.trim();

            // Method 2: Old UI
            const ownerName = document.querySelector('#owner-name a');
            if (ownerName) return ownerName.textContent.trim();

            return null;
        } catch (e) {
            return null;
        }
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
     * Start real-time progress tracking for matched chapter.
     * Sends video.currentTime to backend every 10 seconds.
     */
    function startProgressTracking(chapterMatch) {
        // Stop any existing tracking
        stopProgressTracking();

        if (!chapterMatch) return;

        console.log(`[LifeOS YT] Starting real-time progress tracking for: ${chapterMatch.chapter_title}`);

        // Initial progress update
        sendProgressUpdate(chapterMatch, false);

        // Update every 10 seconds (user requirement: minimum time to send details)
        progressTrackingInterval = setInterval(() => {
            if (!isContextValid()) {
                stopProgressTracking();
                return;
            }
            sendProgressUpdate(chapterMatch, false);
        }, 10000); // 10 seconds

        // Listen for video ended event
        const videoElement = document.querySelector('video');
        if (videoElement) {
            videoElement.addEventListener('ended', () => {
                console.log('[LifeOS YT] Video ended - marking chapter complete');
                sendProgressUpdate(chapterMatch, true);
                stopProgressTracking();
            }, { once: true });
        }
    }

    /**
     * Stop progress tracking.
     */
    function stopProgressTracking() {
        if (progressTrackingInterval) {
            clearInterval(progressTrackingInterval);
            progressTrackingInterval = null;
            console.log('[LifeOS YT] Stopped progress tracking');
        }
    }

    /**
     * Start a retry loop to find the channel name once YouTube's SPA has rendered it.
     * Stops once found or after 30 seconds.
     */
    function startChannelNameRetry(onFound) {
        if (channelRetryInterval) clearInterval(channelRetryInterval);
        let retries = 0;
        const maxRetries = 15; // 15 x 2s = 30s max
        channelRetryInterval = setInterval(() => {
            retries++;
            const name = getChannelName();
            if (name) {
                lastChannelName = name;
                clearInterval(channelRetryInterval);
                channelRetryInterval = null;
                console.log(`[LifeOS YT] Channel name found (retry ${retries}): ${name}`);
                onFound(name);
            } else if (retries >= maxRetries) {
                clearInterval(channelRetryInterval);
                channelRetryInterval = null;
                console.log('[LifeOS YT] Channel name retry exhausted');
            }
        }, 2000);
    }

    /**
     * Send current video progress to backend.
     * Uses exact video.currentTime (no logic, strictly time).
     */
    async function sendProgressUpdate(chapterMatch, videoEnded) {
        try {
            // Skip progress updates during ads (ad currentTime ≠ real video progress)
            if (isAdPlaying()) {
                console.log('[LifeOS YT] Ad playing - skipping progress update');
                return;
            }

            // PRECAUTION: Verify video is still productive before updating
            const videoTitle = getVideoTitle();
            const currentClassification = classifyVideo(videoTitle);
            
            if (currentClassification === 'distracting') {
                console.log('[LifeOS YT] Distraction video detected - stopping progress tracking');
                stopProgressTracking();
                return;
            }

            const videoElement = document.querySelector('video');
            if (!videoElement) return;

            // Auto-correct duration if it changed (e.g., ad finished, metadata loaded late)
            const latestDuration = getVideoDuration();
            if (latestDuration > 0 && latestDuration !== videoDuration) {
                console.log(`[LifeOS YT] Duration corrected: ${videoDuration}s → ${latestDuration}s`);
                videoDuration = latestDuration;
            }

            // Don't send progress if we still have no valid duration
            if (videoDuration <= 0) {
                console.log('[LifeOS YT] Waiting for valid duration before sending progress...');
                return;
            }

            // Get EXACT current time from video player
            const currentTime = Math.floor(videoElement.currentTime);
            
            // Skip if no meaningful progress
            if (currentTime < 1 && !videoEnded) return;

            const pct = Math.min((currentTime / videoDuration) * 100, 100).toFixed(1);
            console.log(`[LifeOS YT] Progress: ${currentTime}s / ${videoDuration}s (${pct}%)${videoEnded ? ' - VIDEO ENDED' : ''}`);

            // Get auth token
            const { auth_token } = await chrome.storage.local.get('auth_token');
            if (!auth_token) return;

            // Send to backend API (include duration for server-side correction)
            // Also send video_title and channel_name to backfill if missing
            const response = await fetch(`http://127.0.0.1:8000/api/ai/study-plan/${chapterMatch.plan_id}/chapter/${chapterMatch.chapter_index}/update-progress`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${auth_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    watched_seconds: currentTime,
                    video_ended: videoEnded,
                    video_duration_seconds: videoDuration,
                    video_title: videoTitle || null,
                    creator_name: lastChannelName || null
                })
            });

            if (response.ok) {
                const result = await response.json();
                console.log(`[LifeOS YT] Progress updated: ${result.progress_percentage?.toFixed(1)}%${result.is_completed ? ' - COMPLETED ✓' : ''}`);
                
                // If completed, stop tracking
                if (result.is_completed) {
                    stopProgressTracking();
                }
            }
        } catch (error) {
            console.debug('[LifeOS YT] Progress update failed:', error.message);
        }
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
        lastChannelName = null; // Reset channel name for this new video
        if (channelRetryInterval) { clearInterval(channelRetryInterval); channelRetryInterval = null; }

        const classification = classifyVideo(title);
        
        console.log(`[LifeOS YT] "${title}" → ${classification} (immediate classification)`);
        
        // IMMEDIATE: Send classification right away for blocking overlay
        try {
            chrome.runtime.sendMessage({
                type: 'YOUTUBE_VIDEO_INFO',
                data: {
                    title: title,
                    videoId: videoId,
                    classification: classification,
                    duration_seconds: 0, // Will be updated later
                    video_url: window.location.href,
                    channel_name: null // Will be updated later
                },
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[LifeOS YT] Immediate message failed:', chrome.runtime.lastError.message);
                }
            });
        } catch (e) {
            console.debug('[LifeOS YT] Immediate send failed:', e.message);
        }
        
        // DELAYED: Get video duration and channel name (wait for page + ads to finish)
        setTimeout(async () => {
            let channelName = getChannelName();
            let duration = getVideoDuration();

            // If duration is 0 (ad playing or metadata not loaded), wait for valid duration
            if (duration === 0) {
                console.log('[LifeOS YT] Duration not ready (ad may be playing), waiting...');
                duration = await waitForValidDuration(60000); // Wait up to 60s
            }
            
            videoDuration = duration;
            
            if (channelName) {
                lastChannelName = channelName;
            } else {
                console.log('[LifeOS YT] Channel name not ready yet, will retry in background...');
                // Start retry to update lastChannelName — progress updates will pick it up automatically
                startChannelNameRetry((foundName) => {
                    // lastChannelName is already updated inside startChannelNameRetry
                    // The next progress update (every 10s) will send it to backend
                    console.log(`[LifeOS YT] Channel name resolved: ${foundName} — will be sent on next progress update`);
                });
            }
            
            console.log(`[LifeOS YT] Duration: ${duration}s (${Math.floor(duration/60)}m ${duration%60}s) | Channel: ${channelName || '(retrying...)'}`);

            if (!isContextValid()) return;

            // Once-per-video gate: if we already sent the full report for this videoId, skip.
            // Checked inside the callback so it survives yt-navigate-finish resets outside.
            if (delayedReportVideoId === videoId) {
                console.log(`[LifeOS YT] Full report already sent for ${videoId}, skipping duplicate`);
                return;
            }
            delayedReportVideoId = videoId;

            try {
                chrome.runtime.sendMessage({
                    type: 'YOUTUBE_VIDEO_INFO',
                    data: {
                        title: title,
                        videoId: videoId,
                        classification: classification,
                        duration_seconds: duration,
                        video_url: window.location.href,
                        channel_name: channelName
                    },
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.debug('[LifeOS YT] Delayed message failed:', chrome.runtime.lastError.message);
                    } else if (response && response.chapter_match) {
                        currentChapterMatch = response.chapter_match;
                        console.log(`[LifeOS YT] Matched to chapter: ${currentChapterMatch.chapter_title}${currentChapterMatch.match_type === 'rewatch' || currentChapterMatch.match_type === 'pending_rewatch' ? ' [RE-WATCH]' : ''}`);
                        
                        // START REAL-TIME PROGRESS TRACKING (even for re-watches — for analytics)
                        startProgressTracking(currentChapterMatch);
                    } else {
                        console.log('[LifeOS YT] No chapter match returned from background');
                    }
                });
            } catch (e) {
                // Extension context invalidated
                console.debug('[LifeOS YT] Delayed send failed:', e.message);
            }
        }, 3000); // Wait 3 seconds for video player to load
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
    setTimeout(reportVideoInfo, 500);

    // ── Periodic check for video changes ──
    trackingInterval = setInterval(() => {
        if (!isContextValid()) return;
        if (window.location.pathname.startsWith('/watch')) {
            const videoId = getVideoId();
            const title = getVideoTitle();
            
            // Only report if video changed
            if ((videoId && videoId !== lastVideoId) || (title && title !== lastTitle)) {
                reportVideoInfo();
            }
            
            // Update duration periodically (in case it wasn't loaded initially)
            if (videoId === lastVideoId && videoDuration === 0) {
                const duration = getVideoDuration();
                if (duration > 0) {
                    videoDuration = duration;
                    console.log(`[LifeOS YT] Duration updated: ${duration}s`);
                }
            }
        }
    }, 5000); // Check every 5 seconds

    // ── YouTube SPA Navigation ───────────────────────────────
    window.addEventListener('yt-navigate-finish', () => {
        if (!isContextValid()) return;
        checkShortsRedirect();

        // Stop progress tracking for previous video
        stopProgressTracking();

        // Stop channel retry for previous video
        if (channelRetryInterval) { clearInterval(channelRetryInterval); channelRetryInterval = null; }

        // Clear previous video's classification
        chrome.storage.local.set({ 'yt_current_classification': 'pending' });

        // Reset state for new video
        lastVideoId = null;
        lastTitle = null;
        lastChannelName = null;
        videoDuration = 0;
        currentChapterMatch = null;
        // NOTE: delayedReportVideoId intentionally NOT reset here — it is a once-per-videoId
        // gate that prevents re-sending YOUTUBE_VIDEO_INFO even if yt-navigate-finish fires twice.
        // A different videoId will naturally bypass it.
        
        // Small delay to let the new page title settle
        setTimeout(reportVideoInfo, 500);
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
