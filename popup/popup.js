/**
 * LifeOS – Extension Popup Script
 * Handles authentication and status display.
 */

const API_BASE = 'http://127.0.0.1:8000/api';

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

// Status fields
const trackingStatus = document.getElementById('trackingStatus');
const currentDomain = document.getElementById('currentDomain');
const activeStatus = document.getElementById('activeStatus');
const queueSize = document.getElementById('queueSize');
const wsStatus = document.getElementById('wsStatus');
const blockBtn = document.getElementById('blockBtn');


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
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Login failed');
        }

        const data = await response.json();
        await chrome.storage.local.set({
            auth_token: data.access_token,
            user_data: data.user,
        });

        // Notify background to initialize WebSocket
        chrome.runtime.sendMessage({ type: 'LOGIN_SUCCESS' });

        showDashboard(data.user);
    } catch (error) {
        authError.textContent = error.message;
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign In';
    }
});

logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['auth_token', 'user_data']);
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
    userName.textContent = `👋 ${user.username}`;
    refreshStatus();
}

async function refreshStatus() {
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
            trackingStatus.textContent = d.isTracking ? '● Active' : '○ Paused';
            trackingStatus.style.color = d.isTracking ? '#00ff88' : '#888';
            currentDomain.textContent = d.domain || '—';
            activeStatus.textContent = d.isActive ? '✓ Yes' : '✗ No';
            activeStatus.style.color = d.isActive ? '#00ff88' : '#ff6b6b';
            queueSize.textContent = d.queueSize || '0';
            wsStatus.textContent = d.wsConnected ? 'Connected' : 'Disconnected';
            wsStatus.style.color = d.wsConnected ? '#00ff88' : '#ff6b6b';
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
        console.log('Status refresh failed:', e);
    }
}

// ── Manual Blocking ────────────────────────────────────
blockBtn.addEventListener('click', async () => {
    const domain = currentDomain.textContent;
    if (!domain || domain === '—') return;

    console.log(`[Popup] Manual block request for: ${domain}`);

    const blockedMap = await new Promise(r => chrome.storage.local.get('blocking_rules_map', (res) => r(res.blocking_rules_map || {})));
    const isBlocked = !!blockedMap[domain];

    blockBtn.disabled = true;
    blockBtn.textContent = isBlocked ? 'Unblocking...' : 'Blocking...';

    chrome.runtime.sendMessage({
        type: isBlocked ? 'UNBLOCK_DOMAIN' : 'BLOCK_DOMAIN',
        data: { domain }
    }, (response) => {
        console.log(`[Popup] Block response:`, response);
        blockBtn.disabled = false;
        refreshStatus();
    });
});


// ── Initialize ──────────────────────────────────────────
async function init() {
    const result = await chrome.storage.local.get(['auth_token', 'user_data']);

    if (result.auth_token && result.user_data) {
        showDashboard(result.user_data);
    } else {
        showAuth();
    }
}

init();

// Auto-refresh status every 5 seconds
setInterval(refreshStatus, 5000);
