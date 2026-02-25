/**
 * LifeOS – Service Worker (Background Script)
 * Manifest v3 compliant with heartbeat resilience.
 * 
 * Responsibilities:
 * - Heartbeat alarm (worker sleep recovery)
 * - Active vs idle tracking integrity
 * - Offline-first smart buffering
 * - WebSocket connection for blocking rules + live activity relay
 * - Message relay from content scripts
 * - Immediate tab-open / tab-close reporting
 */

import { sanitizeUrl, sanitizeTrackingData } from '../utils/privacyFilter.js';
import { sendTrackingLog, sendBatchLogs, isAuthenticated } from '../utils/api.js';
import { enqueue, getQueue, clearQueue, dequeue, getSetting } from '../utils/storage.js';
import { connectWebSocket, sendHeartbeat, isConnected, sendMessage } from '../utils/websocket.js';
import { blockDomain, unblockDomain, syncBlockedDomains } from '../blocking/dynamicRules.js';


// ═══════════════════════════════════════════════════════════
//  SIDEBAR PANEL
// ═══════════════════════════════════════════════════════════

chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});


// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════

const DEFAULT_DISTRACTING_DOMAINS = [
    'youtube.com', 'reddit.com', 'twitter.com', 'x.com', 'instagram.com',
    'facebook.com', 'tiktok.com', 'twitch.tv', '9gag.com', 'buzzfeed.com',
    'netflix.com', 'primevideo.com', 'hotstar.com'
];

let activeTabId = null;
let activeTabDomain = '';
let sessionStart = null;
let tabSwitchCount = 0;
let isWindowFocused = true;
let isUserActive = true;
let trackingInterval = null;
let focusLossTimeout = null;
let isFinalizing = false;
let currentPageTitle = null;
let ytTabClassifications = {};
let tabPageTitles = {}; // Store page titles per tab to preserve across sessions

// Keepalive for productive YouTube sessions — prevents idle from pausing
// while user is legitimately watching a learning video.
let ytProductiveKeepalive = null;

function startYtKeepAlive() {
    if (ytProductiveKeepalive) return; // already running
    ytProductiveKeepalive = setInterval(() => {
        // If we're still on a productive YouTube tab, ensure session is active.
        if (activeTabDomain && activeTabDomain.includes('youtube.com')) {
            const cls = ytTabClassifications[activeTabId] || 'none';
            if (cls === 'productive') {
                if (!sessionStart) {
                    // Session was paused by idle — restore it silently
                    sessionStart = Date.now();
                    isUserActive = true;
                    saveSessionState();
                    sendLiveActivity({ domain: activeTabDomain, status: 'active' });
                    console.log('[KeepAlive] Restored productive YouTube session (was idle-paused)');
                }
            } else {
                stopYtKeepAlive(); // Video changed to non-productive
            }
        } else {
            stopYtKeepAlive(); // Tab changed away from YouTube
        }
    }, 15000); // Every 15 seconds — fast recovery if session is accidentally paused
    console.log('[KeepAlive] Started productive-YouTube keepalive');
}

function stopYtKeepAlive() {
    if (ytProductiveKeepalive) {
        clearInterval(ytProductiveKeepalive);
        ytProductiveKeepalive = null;
        console.log('[KeepAlive] Stopped productive-YouTube keepalive');
    }
}

// ── Session State Persistence (survives service worker sleep) ──
async function saveSessionState() {
    await chrome.storage.local.set({
        _session: {
            tabId: activeTabId,
            domain: activeTabDomain,
            start: sessionStart,
            title: currentPageTitle,
            tabSwitches: tabSwitchCount,
            tabPageTitles: tabPageTitles,  // Persist per-tab titles
            ytTabClassifications: ytTabClassifications,  // Persist YT classifications
        }
    });
}

async function restoreSessionState() {
    const { _session } = await chrome.storage.local.get('_session');
    if (_session) {
        activeTabId = _session.tabId;
        activeTabDomain = _session.domain || '';
        sessionStart = _session.start;
        currentPageTitle = _session.title || null;
        tabSwitchCount = _session.tabSwitches || 0;
        tabPageTitles = _session.tabPageTitles || {};  // Restore per-tab titles
        ytTabClassifications = _session.ytTabClassifications || {};  // Restore YT classifications
        console.log(`[LifeOS] Restored session: ${activeTabDomain}, started ${sessionStart ? new Date(sessionStart).toISOString() : 'null'}`);
    }
}


// ═══════════════════════════════════════════════════════════
//  LIVE ACTIVITY RELAY (sends to backend WS → frontend)
// ═══════════════════════════════════════════════════════════

function sendLiveActivity(data) {
    const activityData = {
        domain: data.domain || activeTabDomain || '',
        page_title: data.page_title || currentPageTitle || null,
        category: data.category || 'neutral',
        duration_seconds: data.duration_seconds || 0,
        status: data.status || 'active',
        timestamp: new Date().toISOString(),
    };
    
    if (isConnected()) {
        console.log(`[Live] Sending: ${activityData.domain} - "${activityData.page_title}" (${activityData.category})`);
        sendMessage({
            type: 'live_activity',
            data: activityData,
        });
    } else {
        console.log(`[Live] WS not connected, cannot send: ${activityData.domain}`);
    }
}


// ═══════════════════════════════════════════════════════════
//  1. ALARMS (Worker Sleep Recovery)
// ═══════════════════════════════════════════════════════════

// Tracking flush: Every 30 seconds for active sessions
chrome.alarms.create('tracking_flush', { periodInMinutes: 0.5 }); // 30 seconds (Chrome minimum)

// WebSocket heartbeat: Every 30 seconds to keep connection alive
chrome.alarms.create('ws_heartbeat', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    await initPromise;
    
    if (alarm.name === 'tracking_flush') {
        console.log(`[Alarm] tracking_flush fired - activeTabDomain=${activeTabDomain}, session=${sessionStart ? 'active' : 'null'}`);
        // Flush active tracking session
        await finalizeCurrentSession();
        
        // Retry offline queue
        await flushOfflineQueue();
    }
    
    if (alarm.name === 'ws_heartbeat') {
        // WebSocket heartbeat or reconnect
        if (isConnected()) {
            sendHeartbeat();
        } else {
            const authed = await isAuthenticated();
            if (authed) {
                initWebSocket();
            }
        }
    }
});


// ═══════════════════════════════════════════════════════════
//  2. TAB & WINDOW TRACKING
// ═══════════════════════════════════════════════════════════

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await initPromise;
    tabSwitchCount++;
    await handleTabChange(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    await initPromise;
    if (tabId === activeTabId && changeInfo.url) {
        await handleTabChange(tabId);
    }
});

// CRITICAL: When a tab is closed, if it was the active tab, finalize and stop
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    await initPromise;
    delete ytTabClassifications[tabId];
    delete tabPageTitles[tabId]; // Clean up stored title

    if (tabId === activeTabId) {
        console.log(`[LifeOS] Active tab ${tabId} closed, finalizing session for ${activeTabDomain}`);
        await finalizeCurrentSession();

        // Send stop activity via WebSocket
        sendLiveActivity({ domain: activeTabDomain, status: 'stopped', duration_seconds: 0 });

        // Reset state
        activeTabId = null;
        activeTabDomain = '';
        sessionStart = null;
        currentPageTitle = null;
        tabSwitchCount = 0;
        await chrome.storage.local.set({
            'yt_current_classification': 'none',
            'site_auto_classification': 'none',
        });
        await saveSessionState();
    }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
    await initPromise;
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // User switched away from browser - wait 5 seconds before pausing
        // (allows checking notifications, quick alt-tabs, etc.)
        focusLossTimeout = setTimeout(() => {
            isWindowFocused = false;
            pauseTracking();
        }, 5000); // 5 seconds tolerance
    } else {
        if (focusLossTimeout) {
            clearTimeout(focusLossTimeout);
            focusLossTimeout = null;
        }
        isWindowFocused = true;

        try {
            const [tab] = await chrome.tabs.query({ active: true, windowId: windowId });
            if (tab) {
                await handleTabChange(tab.id);
            }
        } catch (e) { }

        resumeTracking();
    }
});


// ═══════════════════════════════════════════════════════════
//  3. IDLE STATE DETECTION
// ═══════════════════════════════════════════════════════════

// Detect idle after 5 minutes of no mouse/keyboard activity.
// 60s was too aggressive for video watching (no input during playback).
chrome.idle.setDetectionInterval(300);

chrome.idle.onStateChanged.addListener(async (state) => {
    await initPromise;
    console.log(`[Idle] State: ${state}`);

    if (state === 'active') {
        isUserActive = true;
        resumeTracking();
    } else if (state === 'idle' || state === 'locked') {
        // ADDITIVE: Don't pause for mere 'idle' if user is watching a productive YouTube video.
        // Video playback is active learning behaviour even without mouse/keyboard input.
        // We still pause on 'locked' (screen off / sleep) which is always genuine inactivity.
        if (state === 'idle' && activeTabDomain && activeTabDomain.includes('youtube.com')) {
            const ytClass = ytTabClassifications[activeTabId] || 'none';
            if (ytClass === 'productive') {
                console.log('[Idle] Skipping pause — watching productive YouTube video (idle suppressed)');
                return;
            }
        }
        // Pause tracking on BOTH idle and locked states
        // idle = no mouse/keyboard for 60s, locked = screen locked / sleep
        isUserActive = false;
        pauseTracking();
        stopYtKeepAlive(); // Stop keepalive on genuine sleep/lock
        console.log(`[Idle] Paused tracking: ${state}`);
    }
});


// ═══════════════════════════════════════════════════════════
//  4. TRACKING LOGIC
// ═══════════════════════════════════════════════════════════

async function handleTabChange(tabId) {
    console.log(`[Track] handleTabChange called for tab ${tabId}`);
    
    // Finalize previous tracking period
    await finalizeCurrentSession();
    stopYtKeepAlive(); // New tab — stop any existing keepalive

    // Start new session
    try {
        const tab = await chrome.tabs.get(tabId);
        console.log(`[Track] Tab URL: ${tab?.url?.substring(0, 50)}...`);
        
        if (!tab.url || tab.url.startsWith('chrome://')) {
            console.log(`[Track] Skipping non-trackable URL`);
            activeTabId = null;
            activeTabDomain = '';
            currentPageTitle = null;
            await chrome.storage.local.set({
                'yt_current_classification': 'none',
                'site_auto_classification': 'none',
            });
            await saveSessionState();
            sendLiveActivity({ domain: '', status: 'stopped' });
            return;
        }

        // Skip localhost / 127.0.0.1 — our own app pages shouldn't be tracked
        const rawHostname = new URL(tab.url).hostname.toLowerCase();
        if (rawHostname === '127.0.0.1' || rawHostname === 'localhost' || rawHostname === '0.0.0.0') {
            console.log(`[Track] Skipping localhost/self: ${rawHostname}`);
            activeTabId = null;
            activeTabDomain = '';
            currentPageTitle = null;
            await chrome.storage.local.set({
                'yt_current_classification': 'none',
                'site_auto_classification': 'none',
            });
            await saveSessionState();
            sendLiveActivity({ domain: '', status: 'stopped' });
            return;
        }

        activeTabId = tabId;
        activeTabDomain = sanitizeUrl(tab.url);
        sessionStart = Date.now();
        
        // Use stored title if available (for YouTube), otherwise use tab.title for other sites
        currentPageTitle = tabPageTitles[tabId] || tab.title || null;

        // Reset classification for new domain
        await chrome.storage.local.set({ 'yt_current_classification': 'none' });

        // Check if domain is in default distracting list
        const isDistracting = DEFAULT_DISTRACTING_DOMAINS.some(d =>
            activeTabDomain === d || activeTabDomain.endsWith('.' + d)
        );
        if (isDistracting && !activeTabDomain.includes('youtube.com')) {
            await chrome.storage.local.set({ 'site_auto_classification': 'distracting' });
        } else {
            await chrome.storage.local.set({ 'site_auto_classification': 'none' });
        }

        await saveSessionState();

        // TRIGGER BLOCK CHECK for content script
        try {
            chrome.tabs.sendMessage(tabId, { type: 'CHECK_BLOCK' });
        } catch (e) {
            // Content script might not be loaded yet - that's OK, it will check on load
        }

        // IMMEDIATELY send live activity for new tab
        const category = isDistracting ? 'distracting' : 'neutral';
        sendLiveActivity({
            domain: activeTabDomain,
            page_title: currentPageTitle || tab.title || null,
            category: category,
            status: 'active',
            duration_seconds: 0,
        });

        console.log(`[Track] New session: ${activeTabDomain}${currentPageTitle ? ' - "' + currentPageTitle + '"' : ''}`);
    } catch (e) {
        console.error(`[Track] handleTabChange error:`, e);
        activeTabId = null;
        activeTabDomain = '';
        currentPageTitle = null;
        await saveSessionState();
    }
}

// Max session duration cap (seconds). Flush alarm runs every 30s;
// anything over 65s indicates the system was asleep/suspended.
// Set to 65 to allow full 60s keepalive cycles without incorrect capping.
const MAX_SESSION_DURATION_SECONDS = 65;

async function finalizeCurrentSession() {
    if (!activeTabDomain || !sessionStart || isFinalizing) {
        console.log(`[Track] Skip finalize: domain=${activeTabDomain}, session=${sessionStart}, finalizing=${isFinalizing}`);
        return;
    }
    isFinalizing = true;

    try {
        const now = Date.now();
        let duration = Math.floor((now - sessionStart) / 1000);
        console.log(`[Track] Finalizing: ${activeTabDomain}, raw duration=${duration}s`);

        if (duration < 1) {
            isFinalizing = false;
            return;
        }

        // CAP duration to handle laptop sleep/suspend/idle gaps
        // Since we flush every 30s, anything over 60s means the system was
        // suspended and this isn't real active time.
        if (duration > MAX_SESSION_DURATION_SECONDS) {
            console.log(`[Track] Duration capped: ${duration}s → ${MAX_SESSION_DURATION_SECONDS}s (system was likely suspended)`);
            duration = MAX_SESSION_DURATION_SECONDS;
        }

        // Capture data BEFORE reset
        const logDomain = activeTabDomain;
        let logTitle = currentPageTitle;
        const logSwitches = tabSwitchCount;
        const wasActive = isWindowFocused;
        
        // FIX: If currentPageTitle is null but we have a stored title for this tab, use it
        if (!logTitle && activeTabId && tabPageTitles[activeTabId]) {
            logTitle = tabPageTitles[activeTabId];
            console.log(`[Track] Using stored title: "${logTitle}"`);
        }

        // Reset state synchronously BEFORE await
        sessionStart = now;
        tabSwitchCount = 0;
        await saveSessionState();

        // If this is a YouTube tab, include the extension's video classification
        // so the backend can categorise accurately (html/css/semantic etc. titles
        // are not in the backend keyword list but the extension already knows).
        const ytClassForLog = (logDomain && logDomain.includes('youtube.com') && activeTabId)
            ? (ytTabClassifications[activeTabId] || null)
            : null;

        const logEntry = {
            domain: logDomain,
            duration_seconds: duration,
            tab_switches: logSwitches,
            scroll_depth: 0,
            is_active: wasActive,
            timestamp: new Date().toISOString(),
            ...(logTitle ? { page_title: logTitle } : {}),
            ...(ytClassForLog ? { yt_classification: ytClassForLog } : {}),
        };

        const sanitized = sanitizeTrackingData(logEntry);
        console.log(`[Track] Log entry:`, JSON.stringify(sanitized));

        try {
            const authed = await isAuthenticated();
            if (!authed) {
                console.log(`[Track] Not authenticated, queuing`);
                await enqueue(sanitized);
            } else {
                await sendTrackingLog(sanitized);
                console.log(`[Track] Sent: ${logDomain} ${duration}s${logTitle ? ' "' + logTitle + '"' : ''}`);
            }
        } catch (error) {
            console.log('[Track] Queuing offline:', error.message);
            await enqueue(sanitized);
        }

        // Also send live activity for real-time relay
        sendLiveActivity({
            domain: logDomain,
            page_title: logTitle,
            duration_seconds: duration,
            status: 'active',
        });
    } finally {
        isFinalizing = false;
    }
}

function pauseTracking() {
    finalizeCurrentSession();
    sessionStart = null;
    saveSessionState();
    sendLiveActivity({ domain: activeTabDomain, status: 'paused' });
}

function resumeTracking() {
    if (isWindowFocused && activeTabId && !sessionStart) {
        sessionStart = Date.now();
        saveSessionState();
        sendLiveActivity({ domain: activeTabDomain, status: 'active' });
        // ADDITIVE: After waking from sleep/idle, ask YouTube content script to re-classify
        // the current video. The content script has a once-per-video gate that prevents
        // re-sending — RECHECK_CLASSIFICATION resets it so fresh NLP matching can run.
        // 1 second delay gives the page time to be ready after wake.
        if (activeTabDomain && activeTabDomain.includes('youtube.com') && activeTabId) {
            setTimeout(() => {
                chrome.tabs.sendMessage(activeTabId, { type: 'RECHECK_CLASSIFICATION' }).catch(() => {});
            }, 1000);
        }
    }
}


// ═══════════════════════════════════════════════════════════
//  5. OFFLINE QUEUE FLUSH
// ═══════════════════════════════════════════════════════════

async function flushOfflineQueue() {
    const queue = await getQueue();
    if (queue.length === 0) return;

    console.log(`[Queue] Flushing ${queue.length} entries`);

    try {
        const authed = await isAuthenticated();
        if (!authed) return;

        const result = await sendBatchLogs(queue);
        if (result && result.ingested > 0) {
            await clearQueue();
            console.log(`[Queue] Synced ${result.ingested} entries`);
        }
    } catch (error) {
        console.log('[Queue] Flush failed, will retry:', error.message);
    }
}


// ═══════════════════════════════════════════════════════════
//  6. WEBSOCKET FOR BLOCKING RULES + LIVE RELAY
// ═══════════════════════════════════════════════════════════

function initWebSocket() {
    connectWebSocket((message) => {
        console.log('[WS] Received:', message.type);

        switch (message.type) {
            case 'site_blocked':
                blockDomain(message.data.domain);
                break;

            case 'site_unblocked':
                unblockDomain(message.data.domain);
                break;

            case 'blocked_list_sync':
                syncBlockedDomains(message.data.domains || []);
                break;

            case 'heartbeat_ack':
                break;

            case 'live_tracking':
                // Ignore — this is meant for the frontend dashboard
                break;

            default:
                console.log('[WS] Unknown event:', message.type);
        }
    });
}


// ═══════════════════════════════════════════════════════════
//  7. MESSAGE HANDLER (Content Script → Background)
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handleMessage = async () => {
        await initPromise;
        try {
            switch (message.type) {
                case 'SCROLL_UPDATE':
                    if (sender.tab && sender.tab.id === activeTabId) {
                        // Store scroll depth for next finalization
                    }
                    return { ack: true };

                case 'FOCUS_UPDATE':
                    return { ack: true };

                case 'YOUTUBE_VIDEO_INFO':
                    console.log(`[YT] Received YOUTUBE_VIDEO_INFO from tab ${sender?.tab?.id}`);
                    if (sender.tab && message.data) {
                        const tabId = sender.tab.id;
                        const classification = message.data.classification;

                        ytTabClassifications[tabId] = classification;
                        
                        // Store page title per tab (not just for active tab)
                        if (message.data.title) {
                            tabPageTitles[tabId] = message.data.title;
                            // IMPORTANT: Always save session state to persist title across service worker restarts
                            await saveSessionState();
                        }

                        console.log(`[YT] Tab ${tabId} video: "${message.data.title}" → ${classification}, activeTabId=${activeTabId}`);
                        if (tabId === activeTabId) {
                            currentPageTitle = message.data.title || null;
                            console.log(`[YT] Active Video: "${currentPageTitle}" → ${classification}`);
                            // IMMEDIATE SYNC TO STORAGE FOR CONTENT SCRIPT OVERLAY
                            await chrome.storage.local.set({ 'yt_current_classification': classification });
                            await saveSessionState();

                            // START / STOP productive-YouTube keepalive
                            if (classification === 'productive') {
                                startYtKeepAlive();
                                // IMMEDIATE: ensure session is running right now —
                                // don't wait up to 58s for the keepalive interval to fire.
                                if (!sessionStart) {
                                    sessionStart = Date.now();
                                    isUserActive = true;
                                    await saveSessionState();
                                    sendLiveActivity({ domain: activeTabDomain, status: 'active' });
                                    console.log('[YT] Session started immediately for productive video');
                                }
                            } else {
                                stopYtKeepAlive();
                            }

                            // IMMEDIATELY relay to frontend via WebSocket
                            sendLiveActivity({
                                domain: activeTabDomain,
                                page_title: currentPageTitle,
                                category: classification,
                                status: 'active',
                            });
                            
                            // TRIGGER IMMEDIATE BLOCK CHECK (for immediate blocking/unblocking)
                            try {
                                chrome.tabs.sendMessage(tabId, { type: 'CHECK_BLOCK' });
                            } catch (e) {
                                console.debug('[YT] Failed to send CHECK_BLOCK:', e.message);
                            }
                            
                            // TRY TO MATCH TO ACTIVE CHAPTER AND UPDATE BACKEND (only if duration available)
                            if (message.data.duration_seconds > 0) {
                                const chapterMatch = await matchVideoToChapter({ ...message.data, tabId });
                                if (chapterMatch && chapterMatch.matched) {
                                    console.log(`[YT] Matched to chapter: ${chapterMatch.chapter_title}`);
                                    return { ack: true, chapter_match: chapterMatch };
                                } else if (chapterMatch && !chapterMatch.matched) {
                                    // Pass reason back to content script for page-console visibility
                                    return { ack: true, no_match_reason: chapterMatch.reason };
                                }
                            }
                        }
                    }
                    return { ack: true };

                case 'GET_STATUS':
                    if (!isConnected()) {
                        initWebSocket();
                    }
                    return {
                        ack: true,
                        data: {
                            isTracking: !!sessionStart,
                            domain: activeTabDomain,
                            isActive: isUserActive,
                            isFocused: isWindowFocused,
                            queueSize: (await getQueue()).length,
                            wsConnected: isConnected(),
                            blockingMode: await getSetting('blocking_mode', 'hard'),
                        },
                    };

                case 'LOGIN_SUCCESS':
                    initWebSocket();
                    await flushOfflineQueue();
                    return { ack: true };

                case 'UPDATE_SETTING':
                    await chrome.storage.local.set({ [message.data.key]: message.data.value });
                    if (message.data.key === 'blocking_mode') {
                        const blocked = await chrome.storage.local.get('blocking_rules_map');
                        const domainList = Object.keys(blocked.blocking_rules_map || {});
                        await syncBlockedDomains(domainList);
                    }
                    return { ack: true };

                case 'SET_PENDING_CHAPTER':
                    // Frontend signals which chapter user is searching YouTube for
                    if (message.data) {
                        await chrome.storage.local.set({ 'pending_chapter': message.data });
                        console.log(`[Pending] Stored pending chapter: plan=${message.data.plan_id}, ch=${message.data.chapter_index}`);
                    }
                    return { ack: true };

                case 'BLOCK_DOMAIN':
                    await blockDomain(message.data.domain);
                    if (activeTabId) {
                        chrome.tabs.sendMessage(activeTabId, { type: 'CHECK_BLOCK' }).catch(() => { });
                    }
                    return { ack: true };

                case 'UNBLOCK_DOMAIN':
                    await unblockDomain(message.data.domain);
                    if (activeTabId) {
                        chrome.tabs.sendMessage(activeTabId, { type: 'CHECK_BLOCK' }).catch(() => { });
                    }
                    return { ack: true };

                default:
                    return { ack: false, error: 'Unknown message type' };
            }
        } catch (error) {
            return { ack: false, error: error.message };
        }
    };

    handleMessage().then(sendResponse);
    return true;
});


// ═══════════════════════════════════════════════════════════
//  CHAPTER VIDEO MATCHING (Auto-detect videos for courses)
// ═══════════════════════════════════════════════════════════

async function matchVideoToChapter(videoData) {
    try {
        // NOTE: We intentionally do NOT skip 'distracting' classified videos here.
        // NLP matching is independent of keyword classification — a video might not
        // contain any learning keywords in its title but still be a legitimate chapter
        // video (e.g. "HTML - Introduction - W3Schools.com" before keyword list update).
        // If NLP finds a match we will upgrade the classification to 'productive'.

        const { auth_token } = await chrome.storage.local.get('auth_token');
        if (!auth_token) {
            console.log('[Match] No auth token - cannot match');
            return null;
        }

        // ── STEP 1: Check PENDING chapter assignment (highest priority) ──
        // This is set when user clicks "Search on YouTube" from a specific chapter.
        try {
            const pendingResponse = await fetch('http://127.0.0.1:8000/api/ai/pending-chapter', {
                headers: {
                    'Authorization': `Bearer ${auth_token}`,
                    'Content-Type': 'application/json'
                }
            });
            if (pendingResponse.ok) {
                const pendingData = await pendingResponse.json();
                if (pendingData.pending) {
                    const p = pendingData.pending;
                    console.log(`[Match] PENDING chapter found: "${p.chapter_title}" (plan=${p.plan_id}, ch=${p.chapter_index})`);

                    // Directly assign video to pending chapter
                    const setVideoResponse = await fetch(`http://127.0.0.1:8000/api/ai/study-plan/${p.plan_id}/chapter/${p.chapter_index}/set-video`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${auth_token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            video_url: videoData.video_url,
                            video_duration_seconds: videoData.duration_seconds || 0,
                            video_id: videoData.videoId,
                            video_title: videoData.title,
                            creator_name: videoData.channel_name
                        })
                    });

                    if (setVideoResponse.ok) {
                        console.log(`[Match] ✓ Pending match: "${videoData.title}" → "${p.chapter_title}"`);
                        return {
                            plan_id: p.plan_id,
                            chapter_index: p.chapter_index,
                            chapter_title: p.chapter_title,
                            matched: true,
                            match_type: 'pending'
                        };
                    }

                    // Even if set-video failed (e.g., completed chapter lock), still return match for tracking
                    return {
                        plan_id: p.plan_id,
                        chapter_index: p.chapter_index,
                        chapter_title: p.chapter_title,
                        matched: true,
                        match_type: 'pending_rewatch'
                    };
                }
            }
        } catch (e) {
            console.debug('[Match] Pending check failed:', e.message);
        }

        // ── STEP 2: Semantic matching via backend embedding service ──
        // The backend computes cosine similarity between stored chapter embeddings
        // and the video embedding. Thresholds: ≥0.70 = match, 0.60–0.70 = needs_confirmation.
        // set-video is also called internally by the backend on a successful match.
        try {
            const matchResponse = await fetch('http://127.0.0.1:8000/api/ai/match-video', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${auth_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    video_title: videoData.title,
                    video_url: videoData.video_url,
                    video_id: videoData.videoId,
                    video_description: videoData.description || null,
                    duration_seconds: videoData.duration_seconds || 0,
                    channel_name: videoData.channel_name || null
                })
            });

            if (!matchResponse.ok) {
                console.log(`[Match] /match-video returned ${matchResponse.status}`);
                return { matched: false, reason: `http_${matchResponse.status}` };
            }

            const matchData = await matchResponse.json();

            if (!matchData.matched) {
                const reason = matchData.reason || 'below_threshold';
                console.log(`[Match] No semantic match for "${videoData.title}" → reason: ${reason}`);
                // Return reason so content script can log it in page console
                return { matched: false, reason };
            }

            console.log(
                `[Match] ✓ Semantic: "${videoData.title}" → "${matchData.chapter_title}" ` +
                `(sim=${matchData.similarity}, type=${matchData.match_type})`
            );

            // ── If the video was keyword-classified as 'distracting' but NLP confirmed
            // it belongs to a chapter, upgrade it to 'productive' retroactively so
            // the block overlay is lifted.
            if (videoData.classification === 'distracting' && videoData.tabId) {
                console.log(`[Match] Upgrading tab ${videoData.tabId} classification: distracting → productive (NLP chapter match)`);
                ytTabClassifications[videoData.tabId] = 'productive';
                await chrome.storage.local.set({ 'yt_current_classification': 'productive' });
                await saveSessionState();
                try {
                    chrome.tabs.sendMessage(videoData.tabId, { type: 'CHECK_BLOCK' });
                } catch (e) { /* tab may have closed */ }
            }

            return {
                plan_id: matchData.plan_id,
                chapter_index: matchData.chapter_index,
                chapter_title: matchData.chapter_title,
                matched: true,
                match_type: matchData.match_type,
            };
        } catch (e) {
            console.debug('[Match] /match-video request failed:', e.message);
            return { matched: false, reason: 'network_error: ' + e.message };
        }
    } catch (error) {
        console.error('[Match] Error matching video to chapter:', error);
        return null;
    }
}


// ═══════════════════════════════════════════════════════════
//  8. INITIALIZATION
// ═══════════════════════════════════════════════════════════

async function init() {
    console.log('[LifeOS] Service worker initializing...');

    try {
        const win = await chrome.windows.getLastFocused();
        isWindowFocused = win.focused;
    } catch (e) {
        isWindowFocused = true;
    }

    await restoreSessionState();

    const authed = await isAuthenticated();
    if (authed) {
        flushOfflineQueue().catch(e => console.log('[Init] Queue flush failed:', e.message));
        initWebSocket();
    }

    // Validate restored session: discard stale sessions (system was asleep)
    if (sessionStart) {
        const staleMs = Date.now() - sessionStart;
        if (staleMs > MAX_SESSION_DURATION_SECONDS * 1000) {
            console.log(`[LifeOS] Discarding stale session: ${Math.round(staleMs / 1000)}s old (max ${MAX_SESSION_DURATION_SECONDS}s)`);
            sessionStart = null;
            activeTabId = null;
            activeTabDomain = '';
            currentPageTitle = null;
            await saveSessionState();
        }
    }

    // Verify persisted state matches CURRENT active tab
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && !tab.url.startsWith('chrome://')) {
            const currentDomain = sanitizeUrl(tab.url);

            // Skip localhost/self pages
            const hostname = new URL(tab.url).hostname.toLowerCase();
            if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0') {
                activeTabId = null;
                activeTabDomain = '';
                sessionStart = null;
                currentPageTitle = null;
                await saveSessionState();
            } else if (!activeTabId) {
                activeTabId = tab.id;
                activeTabDomain = currentDomain;
                sessionStart = Date.now();
                await saveSessionState();
            } else if (tab.id !== activeTabId || currentDomain !== activeTabDomain) {
                console.log(`[LifeOS] Tab changed while asleep: ${activeTabDomain} → ${currentDomain}`);
                await finalizeCurrentSession();
                activeTabId = tab.id;
                activeTabDomain = currentDomain;
                sessionStart = Date.now();
                currentPageTitle = null;
                await saveSessionState();
            }
        }
    } catch (e) {
        // No active tab
    }

    console.log(`[LifeOS] Ready. Tracking: ${activeTabDomain || 'none'}, session age: ${sessionStart ? Math.round((Date.now() - sessionStart) / 1000) + 's' : 'none'}`);
    console.log(`[LifeOS] Basic tracking: 30s intervals | Progress tracking: 10s (when matched to chapter)`);
}

const initPromise = init();
