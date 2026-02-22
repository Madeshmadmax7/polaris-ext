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

// ── Session State Persistence (survives service worker sleep) ──
async function saveSessionState() {
    await chrome.storage.local.set({
        _session: {
            tabId: activeTabId,
            domain: activeTabDomain,
            start: sessionStart,
            title: currentPageTitle,
            tabSwitches: tabSwitchCount,
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
        console.log(`[LifeOS] Restored session: ${activeTabDomain}, started ${sessionStart ? new Date(sessionStart).toISOString() : 'null'}`);
    }
}


// ═══════════════════════════════════════════════════════════
//  LIVE ACTIVITY RELAY (sends to backend WS → frontend)
// ═══════════════════════════════════════════════════════════

function sendLiveActivity(data) {
    if (isConnected()) {
        sendMessage({
            type: 'live_activity',
            data: {
                domain: data.domain || activeTabDomain || '',
                page_title: data.page_title || currentPageTitle || null,
                category: data.category || 'neutral',
                duration_seconds: data.duration_seconds || 0,
                status: data.status || 'active',
                timestamp: new Date().toISOString(),
            },
        });
    }
}


// ═══════════════════════════════════════════════════════════
//  1. HEARTBEAT ALARM (Worker Sleep Recovery)
// ═══════════════════════════════════════════════════════════

chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }); // 30 seconds

chrome.alarms.onAlarm.addListener(async (alarm) => {
    await initPromise;
    if (alarm.name === 'heartbeat') {
        // Periodic session flush
        await finalizeCurrentSession();

        // Retry offline queue
        await flushOfflineQueue();

        // WS heartbeat or reconnect
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
        focusLossTimeout = setTimeout(() => {
            isWindowFocused = false;
            pauseTracking();
        }, 300);
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

chrome.idle.setDetectionInterval(600);

chrome.idle.onStateChanged.addListener(async (state) => {
    await initPromise;
    console.log(`[Idle] State: ${state}`);

    if (state === 'active') {
        isUserActive = true;
    } else if (state === 'locked') {
        isUserActive = false;
        pauseTracking();
    }
});


// ═══════════════════════════════════════════════════════════
//  4. TRACKING LOGIC
// ═══════════════════════════════════════════════════════════

async function handleTabChange(tabId) {
    // Finalize previous tracking period
    await finalizeCurrentSession();

    // Start new session
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url || tab.url.startsWith('chrome://')) {
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
        currentPageTitle = null;

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

        // IMMEDIATELY send live activity for new tab
        const category = isDistracting ? 'distracting' : 'neutral';
        sendLiveActivity({
            domain: activeTabDomain,
            page_title: tab.title || null,
            category: category,
            status: 'active',
            duration_seconds: 0,
        });

        console.log(`[Track] New session: ${activeTabDomain}`);
    } catch (e) {
        activeTabId = null;
        activeTabDomain = '';
        currentPageTitle = null;
        await saveSessionState();
    }
}

async function finalizeCurrentSession() {
    if (!activeTabDomain || !sessionStart || isFinalizing) return;
    isFinalizing = true;

    try {
        const now = Date.now();
        const duration = Math.floor((now - sessionStart) / 1000);

        if (duration < 1) {
            isFinalizing = false;
            return;
        }

        // Capture data BEFORE reset
        const logDomain = activeTabDomain;
        const logTitle = currentPageTitle;
        const logSwitches = tabSwitchCount;
        const wasActive = isWindowFocused;

        // Reset state synchronously BEFORE await
        sessionStart = now;
        tabSwitchCount = 0;
        await saveSessionState();

        const logEntry = {
            domain: logDomain,
            duration_seconds: duration,
            tab_switches: logSwitches,
            scroll_depth: 0,
            is_active: wasActive,
            timestamp: new Date().toISOString(),
            ...(logTitle ? { page_title: logTitle } : {}),
        };

        const sanitized = sanitizeTrackingData(logEntry);

        try {
            const authed = await isAuthenticated();
            if (!authed) {
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
                    if (sender.tab && message.data) {
                        const tabId = sender.tab.id;
                        const classification = message.data.classification;

                        ytTabClassifications[tabId] = classification;

                        if (tabId === activeTabId) {
                            currentPageTitle = message.data.title || null;
                            console.log(`[YT] Active Video: "${currentPageTitle}" → ${classification}`);
                            // IMMEDIATE SYNC TO STORAGE FOR CONTENT SCRIPT OVERLAY
                            await chrome.storage.local.set({ 'yt_current_classification': classification });
                            await saveSessionState();

                            // IMMEDIATELY relay to frontend via WebSocket
                            sendLiveActivity({
                                domain: activeTabDomain,
                                page_title: currentPageTitle,
                                category: classification,
                                status: 'active',
                            });
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

    // Verify persisted state matches CURRENT active tab
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && !tab.url.startsWith('chrome://')) {
            const currentDomain = sanitizeUrl(tab.url);

            if (!activeTabId) {
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

    // Fast tracking cycle: flush every 3 seconds for real-time updates
    setInterval(async () => {
        if (sessionStart && isWindowFocused) {
            await finalizeCurrentSession();
        }
        if (isConnected()) {
            sendHeartbeat();
        }
    }, 3000);
}

const initPromise = init();
