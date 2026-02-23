/**
 * LifeOS – Extension Popup Script
 * Sidebar with learning progress, study plans, and tracking status.
 */

const API_BASE = 'http://127.0.0.1:8000/api';
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

// Tabs
const tabBtns = document.querySelectorAll('.tab-btn');
const learningTab = document.getElementById('learningTab');
const trackingTab = document.getElementById('trackingTab');

// Learning Tab Elements
const studyPlansList = document.getElementById('studyPlansList');
const emptyState = document.getElementById('emptyState');
const todayPercentage = document.getElementById('todayPercentage');
const todayProgress = document.getElementById('todayProgress');
const completedChapters = document.getElementById('completedChapters');
const totalChapters = document.getElementById('totalChapters');
const studyPlansCount = document.getElementById('studyPlansCount');

// Tracking Tab Elements
const trackingStatus = document.getElementById('trackingStatus');
const currentDomain = document.getElementById('currentDomain');
const activeStatus = document.getElementById('activeStatus');
const queueSize = document.getElementById('queueSize');
const wsStatus = document.getElementById('wsStatus');
const blockBtn = document.getElementById('blockBtn');


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
        loadLearningData();
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


// ── Tab Navigation ──────────────────────────────────────
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        
        // Update active tab button
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Show corresponding tab content
        learningTab.classList.remove('active');
        trackingTab.classList.remove('active');
        
        if (tabName === 'learning') {
            learningTab.classList.add('active');
        } else if (tabName === 'tracking') {
            trackingTab.classList.add('active');
            refreshTrackingStatus();
        }
    });
});


// ── Learning Data ───────────────────────────────────────
async function loadLearningData() {
    if (!authToken) {
        console.log('[Popup] No auth token, skipping learning data load');
        return;
    }
    
    try {
        studyPlansList.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading...</p></div>';
        
        const [plans, allProgress] = await Promise.all([
            apiRequest('/ai/study-plans'),
            Promise.all([]).catch(() => []) // Will fetch individual progress below
        ]);

        if (!plans || plans.length === 0) {
            studyPlansList.style.display = 'none';
            emptyState.style.display = 'block';
            updateOverallProgress(0, 0, 0);
            return;
        }

        studyPlansList.style.display = 'block';
        emptyState.style.display = 'none';

        // Fetch progress for each plan
        const plansWithProgress = await Promise.all(
            plans.map(async (plan) => {
                try {
                    const progress = await apiRequest(`/ai/study-plan/${plan.id}/progress`);
                    return { ...plan, progress };
                } catch {
                    return { ...plan, progress: null };
                }
            })
        );

        // Calculate overall stats
        let totalChaps = 0;
        let completedChaps = 0;
        plansWithProgress.forEach(plan => {
            if (plan.progress) {
                totalChaps += plan.progress.total_chapters || 0;
                completedChaps += plan.progress.completed_chapters || 0;
            }
        });

        updateOverallProgress(completedChaps, totalChaps, plans.length);
        renderStudyPlans(plansWithProgress);
    } catch (error) {
        console.log('[Popup] Learning data load failed:', error.message);
        studyPlansList.style.display = 'none';
        emptyState.style.display = 'block';
    }
}

function updateOverallProgress(completed, total, planCount) {
    completedChapters.textContent = completed;
    totalChapters.textContent = total;
    studyPlansCount.textContent = planCount;
    
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    todayPercentage.textContent = `${percentage}%`;
    todayProgress.style.width = `${percentage}%`;
}

function renderStudyPlans(plans) {
    if (!plans || plans.length === 0) {
        studyPlansList.innerHTML = '';
        return;
    }

    studyPlansList.innerHTML = plans.map(plan => {
        const chapters = plan.plan_data?.chapters || [];
        const progress = plan.progress;
        const completed = progress?.completed_chapters || 0;
        const total = progress?.total_chapters || chapters.length;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
        const quizUnlocked = plan.quiz_unlocked || false;

        return `
            <div class="study-plan-card">
                <div class="plan-header">
                    <h4 class="plan-title">${plan.title || plan.goal}</h4>
                    <span class="plan-days">${plan.duration_days}d</span>
                </div>
                
                <div class="plan-progress">
                    <div class="progress-info">
                        <span class="progress-text">${completed}/${total} chapters</span>
                        <span class="progress-percent">${percentage}%</span>
                    </div>
                    <div class="progress-bar-small">
                        <div class="progress-fill-small" style="width: ${percentage}%"></div>
                    </div>
                </div>

                ${chapters.length > 0 ? `
                    <div class="chapters-list">
                        ${chapters.slice(0, 3).map((chapter, idx) => {
                            const chapterProgress = progress?.chapters?.find(c => c.chapter_index === chapter.chapter_number);
                            const isCompleted = chapterProgress?.is_completed || false;
                            const watchProgress = chapterProgress?.progress_percentage || 0;
                            const watchedSeconds = chapterProgress?.watched_seconds || 0;
                            const videoDuration = chapterProgress?.video_duration_seconds || 0;
                            const hasVideo = videoDuration > 0;
                            
                            return `
                                <div class="chapter-item ${isCompleted ? 'completed' : ''}">
                                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                                        <div style="display: flex; align-items: center; gap: 6px;">
                                            <span class="chapter-check">${isCompleted ? '✓' : '○'}</span>
                                            <span class="chapter-name">${chapter.title}</span>
                                        </div>
                                        ${hasVideo ? `<span style="font-size: 10px; color: var(--text-muted);">${Math.round(watchProgress)}%</span>` : ''}
                                    </div>
                                    ${hasVideo ? `
                                        <div style="width: 100%; height: 3px; background: var(--bg-elevated); border-radius: 2px; margin-top: 4px; overflow: hidden;">
                                            <div style="width: ${watchProgress}%; height: 100%; background: linear-gradient(90deg, var(--color-primary), var(--color-secondary)); transition: width 0.3s ease;"></div>
                                        </div>
                                    ` : ''}
                                </div>
                            `;
                        }).join('')}
                        ${chapters.length > 3 ? `<div class="chapters-more">+${chapters.length - 3} more</div>` : ''}
                    </div>
                ` : ''}

                ${quizUnlocked ? `
                    <div class="quiz-badge">
                        <span class="badge-icon">🎯</span>
                        <span>Quiz Unlocked!</span>
                    </div>
                ` : ''}

                <a href="http://127.0.0.1:5173/learning" target="_blank" class="plan-link">
                    View Full Plan →
                </a>
            </div>
        `;
    }).join('');
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
            trackingStatus.textContent = d.isTracking ? 'Active' : 'Paused';
            trackingStatus.className = `status-badge ${d.isTracking ? 'active' : 'paused'}`;
            
            currentDomain.textContent = d.domain || '—';
            activeStatus.textContent = d.isActive ? '✓ Yes' : '✗ No';
            activeStatus.style.color = d.isActive ? '#00ff88' : '#ff6b6b';
            queueSize.textContent = d.queueSize || '0';
            wsStatus.textContent = d.wsConnected ? 'Connected' : 'Disconnected';
            wsStatus.style.color = d.wsConnected ? '#00ff88' : '#ff6b6b';
            statusDot.className = `status-indicator ${d.wsConnected ? 'connected' : 'disconnected'}`;

            // Update Block Button (only if tracking tab is visible)
            if (d.domain && trackingTab.classList.contains('active')) {
                const blockedMap = await new Promise(r => chrome.storage.local.get('blocking_rules_map', (res) => r(res.blocking_rules_map || {})));
                const isBlocked = !!blockedMap[d.domain];
                blockBtn.textContent = isBlocked ? 'Unblock Site' : 'Block This Site';
                blockBtn.style.display = 'block';
            } else if (trackingTab.classList.contains('active')) {
                blockBtn.style.display = 'none';
            }
        }
    } catch (e) {
        // Silent fail - background script might not be ready
    }
}

// ── Manual Blocking ────────────────────────────────────
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
    loadLearningData();
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
        loadLearningData();
        refreshTrackingStatus();
    } else {
        showAuth();
    }
}

init();

// Auto-refresh tracking status every 3 seconds for real-time updates
setInterval(() => {
    if (authToken) {
        refreshTrackingStatus(); // Always refresh tracking status for live updates
    }
}, 3000);

// Auto-refresh learning data every 30 seconds (only when tab is active)
setInterval(() => {
    if (authToken && learningTab.classList.contains('active')) {
        loadLearningData();
    }
}, 30000);
