/**
 * LifeOS – API Client (Extension)
 * Handles all backend communication with retry logic.
 */

const API_BASE = 'http://127.0.0.1:8000/api';

/**
 * Get stored auth token.
 */
async function getToken() {
    const result = await chrome.storage.local.get('auth_token');
    return result.auth_token || null;
}

/**
 * Make an authenticated API request with retry.
 * @param {string} endpoint 
 * @param {Object} options 
 * @param {number} retries 
 * @returns {Promise<Object>}
 */
export async function apiRequest(endpoint, options = {}, retries = 3) {
    const token = await getToken();

    const config = {
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            ...options.headers,
        },
        ...options,
    };

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, config);

            if (response.ok) {
                return await response.json();
            }

            // Don't retry auth errors
            if (response.status === 401 || response.status === 403) {
                throw new Error(`Auth error: ${response.status}`);
            }

            // Retry on server errors
            if (response.status >= 500 && attempt < retries - 1) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }

            throw new Error(`API error: ${response.status}`);
        } catch (error) {
            if (attempt === retries - 1) {
                throw error;
            }
            // Wait before retry with exponential backoff
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
}

/**
 * Send tracking log to backend.
 */
export async function sendTrackingLog(logData) {
    return apiRequest('/tracking/log', {
        method: 'POST',
        body: JSON.stringify(logData),
    });
}

/**
 * Send batch tracking logs (from offline buffer).
 */
export async function sendBatchLogs(logs) {
    return apiRequest('/tracking/batch', {
        method: 'POST',
        body: JSON.stringify({ logs }),
    });
}

/**
 * Get blocked sites for current user.
 */
export async function getBlockedSites(childId) {
    return apiRequest(`/parental/blocked-sites/${childId}`);
}

/**
 * Login and store token.
 */
export async function login(email, password) {
    const response = await apiRequest('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
    });
    if (response.access_token) {
        await chrome.storage.local.set({
            auth_token: response.access_token,
            user_data: response.user,
        });
    }
    return response;
}

/**
 * Check if user is authenticated.
 */
export async function isAuthenticated() {
    const token = await getToken();
    return !!token;
}
