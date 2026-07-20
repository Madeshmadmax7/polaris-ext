/**
 * Polaris – Extension Popup Script (V1)
 * Tracking status + daily productivity score.
 * [V2+] Learning tab with study plans commented out.
 */

const API_BASE = 'http://localhost:8000/api';
let authToken = null;

// ── DOM Elements ────────────────────────────────────────
const authSection = document.getElementById('authSection');
const dashboardSection = document.getElementById('dashboardSection');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const authError = document.getElementById('authError');
const userName = document.getElementById('userName');
const statusDot = document.getElementById('statusDot');
const refreshBtn = document.getElementById('refreshBtn');

// Tracking Elements
const trackingStatus = document.getElementById('trackingStatus');
const currentDomain = document.getElementById('currentDomain');
const activeStatus = document.getElementById('activeStatus');
const queueSize = document.getElementById('queueSize');
const wsStatus = document.getElementById('wsStatus');
const blockBtn = document.getElementById('blockBtn');

// [V1] Productivity Elements
const productivityScore = document.getElementById('productivityScore');
const scoreProgress = document.getElementById('scoreProgress');
const totalActiveTime = document.getElementById('totalActiveTime');
const productiveTime = document.getElementById('productiveTime');
const distractingTime = document.getElementById('distractingTime');


// ── API Helper ──────────────────────────────────────────
async function apiRequest(endpoint, options = {}) {
    try {
        const headers = {
            'Content-Type': 'application/json',
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        };

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers: { ...headers, ...options.headers },
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || 'Request failed');
        }

        return await response.json();
    } catch (error) {
        console.error(`API Error [${endpoint}]:`, error);
        throw error;
    }
}


// ── Auth ────────────────────────────────────────────────
loginBtn.addEventListener('click', async () => {
    const email = loginEmail.value.trim();
    const password = loginPassword.value;

    if (!email || !password) {
        authError.textContent = 'Please fill in all fields';
        return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
    authError.textContent = '';

    try {
        const data = await apiRequest('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });

        authToken = data.access_token;
        await chrome.storage.local.set({
            auth_token: data.access_token,
            user_data: data.user,
        });

        // Notify background to initialize WebSocket
        chrome.runtime.sendMessage({ type: 'LOGIN_SUCCESS' });

        showDashboard(data.user);
        loadProductivityData();
    } catch (error) {
        authError.textContent = error.message;
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign In';
    }
});

logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['auth_token', 'user_data']);
    authToken = null;
    showAuth();
});


// ── UI State ────────────────────────────────────────────
function showAuth() {
    authSection.style.display = 'block';
    dashboardSection.style.display = 'none';
    statusDot.className = 'status-indicator';
}

function showDashboard(user) {
    authSection.style.display = 'none';
    dashboardSection.style.display = 'block';
    userName.textContent = user.username;
}


// ── [V1] Productivity Score ─────────────────────────────
function formatMinutes(totalMinutes) {
    if (totalMinutes < 1) return '0m';
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadProductivityData() {
    if (!authToken) return;

    try {
        const data = await apiRequest('/productivity/today');
        const score = Math.round(data.productivity_score || 0);

        productivityScore.textContent = `${score}%`;
        scoreProgress.style.width = `${score}%`;
        totalActiveTime.textContent = formatMinutes(data.total_active_minutes || 0);
        productiveTime.textContent = formatMinutes(data.productive_minutes || 0);
        distractingTime.textContent = formatMinutes(data.distracting_minutes || 0);
    } catch (error) {
        console.log('[Popup] Productivity data load failed:', error.message);
        productivityScore.textContent = '—';
    }
}


// ── Tracking Status ─────────────────────────────────────
async function refreshTrackingStatus() {
    try {
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(res);
                }
            });
        });

        if (response && response.data) {
            const d = response.data;
            if (d.isDashboard) {
                trackingStatus.textContent = 'Dashboard';
                trackingStatus.className = 'status-badge active';
                currentDomain.textContent = 'Polaris System';
            } else {
                trackingStatus.textContent = d.isTracking ? 'Active' : 'Paused';
                trackingStatus.className = `status-badge ${d.isTracking ? 'active' : 'paused'}`;
                currentDomain.textContent = d.domain || '—';
            }
            
            activeStatus.textContent = d.isActive ? 'YES' : 'NO';
            activeStatus.style.opacity = d.isActive ? '1' : '0.4';
            queueSize.textContent = d.queueSize || '0';
            wsStatus.textContent = d.wsConnected ? 'LIVE' : 'OFFLINE';
            wsStatus.style.opacity = d.wsConnected ? '1' : '0.4';
            statusDot.className = `status-indicator ${d.wsConnected ? 'connected' : 'disconnected'}`;

            // Update Block Button
            if (d.domain) {
                const blockedMap = await new Promise(r => chrome.storage.local.get('blocking_rules_map', (res) => r(res.blocking_rules_map || {})));
                const isBlocked = !!blockedMap[d.domain];
                blockBtn.textContent = isBlocked ? 'Unblock Site' : 'Block This Site';
                blockBtn.style.display = 'block';
            } else {
                blockBtn.style.display = 'none';
            }
        }
    } catch (e) {
        // Silent fail - background script might not be ready
    }
}

// Manual blocking
blockBtn.addEventListener('click', async () => {
    const domain = currentDomain.textContent;
    if (!domain || domain === '—') return;

    const blockedMap = await new Promise(r => chrome.storage.local.get('blocking_rules_map', (res) => r(res.blocking_rules_map || {})));
    const isBlocked = !!blockedMap[domain];

    blockBtn.disabled = true;
    blockBtn.textContent = isBlocked ? 'Unblocking...' : 'Blocking...';

    chrome.runtime.sendMessage({
        type: isBlocked ? 'UNBLOCK_DOMAIN' : 'BLOCK_DOMAIN',
        data: { domain }
    }, () => {
        blockBtn.disabled = false;
        refreshTrackingStatus();
    });
});

// Refresh button
refreshBtn.addEventListener('click', () => {
    refreshBtn.style.animation = 'spin 0.5s linear';
    loadProductivityData();
    refreshTrackingStatus();
    setTimeout(() => {
        refreshBtn.style.animation = '';
    }, 500);
});


// ── Initialize ──────────────────────────────────────────
async function init() {
    const result = await chrome.storage.local.get(['auth_token', 'user_data']);

    if (result.auth_token && result.user_data) {
        authToken = result.auth_token;
        showDashboard(result.user_data);
        loadProductivityData();
        refreshTrackingStatus();
    } else {
        showAuth();
    }
}

init();

// Auto-refresh tracking status every 3 seconds for real-time updates
setInterval(() => {
    if (authToken) {
        refreshTrackingStatus();
    }
}, 3000);

// Auto-refresh productivity data every 30 seconds
setInterval(() => {
    if (authToken) {
        loadProductivityData();
    }
}, 30000);


// ═══════════════════════════════════════════════════════════
//  [V2+] LEARNING TAB — Uncomment when study plans are enabled
// ═══════════════════════════════════════════════════════════
//
// // Tab Navigation
// const tabBtns = document.querySelectorAll('.tab-btn');
// const learningTab = document.getElementById('learningTab');
// const trackingTab = document.getElementById('trackingTab');
// const studyPlansList = document.getElementById('studyPlansList');
// const emptyState = document.getElementById('emptyState');
// const todayPercentage = document.getElementById('todayPercentage');
// const todayProgress = document.getElementById('todayProgress');
// const completedChapters = document.getElementById('completedChapters');
// const totalChapters = document.getElementById('totalChapters');
// const studyPlansCount = document.getElementById('studyPlansCount');
//
// tabBtns.forEach(btn => {
//     btn.addEventListener('click', () => {
//         const tabName = btn.dataset.tab;
//         tabBtns.forEach(b => b.classList.remove('active'));
//         btn.classList.add('active');
//         learningTab.classList.remove('active');
//         trackingTab.classList.remove('active');
//         if (tabName === 'learning') {
//             learningTab.classList.add('active');
//         } else if (tabName === 'tracking') {
//             trackingTab.classList.add('active');
//             refreshTrackingStatus();
//         }
//     });
// });
//
// async function loadLearningData() { /* ... */ }
// function updateOverallProgress(completed, total, planCount) { /* ... */ }
// function renderStudyPlans(plans) { /* ... */ }

