/**
 * LifeOS – WebSocket Client (Extension)
 * Maintains persistent WS connection to backend.
 * Handles: blocking rule sync, reconnection, heartbeat.
 */

const WS_URL = 'ws://127.0.0.1:8000/ws';

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 2000;

/**
 * Connect to WebSocket server.
 * @param {Function} onMessage Callback for incoming messages
 */
export async function connectWebSocket(onMessage) {
    const result = await chrome.storage.local.get('auth_token');
    const token = result.auth_token;

    if (!token) {
        console.log('[WS] No auth token, skipping connection');
        return;
    }

    // Close existing connection if any
    if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close();
        ws = null;
    }

    try {
        const encodedToken = encodeURIComponent(token);
        const urlWithToken = `${WS_URL}?token=${encodedToken}`;

        // Log the URL with obfuscated token for debugging
        const debugUrl = `${WS_URL}?token=${token.substring(0, 8)}...`;
        console.log(`[WS] Connecting to: ${debugUrl}`);

        const socket = new WebSocket(urlWithToken);
        ws = socket;

        socket.onopen = () => {
            console.log('[WS] Connected');
            reconnectAttempts = 0;

            // Guard: only send if this socket is still the active one and is OPEN
            if (ws === socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'sync_blocked' }));
            }
        };

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (onMessage) {
                    onMessage(data);
                }
            } catch (e) {
                console.error('[WS] Parse error:', e);
            }
        };

        socket.onclose = (event) => {
            console.log(`[WS] Closed: ${event.code} (Reason: ${event.reason || 'none'})`);
            if (ws === socket) {
                ws = null;
            }
            attemptReconnect(onMessage);
        };

        socket.onerror = (error) => {
            console.error('[WS] Connection Error. ReadyState:', socket.readyState);
            // Some browsers don't provide event details on onerror for security,
            // so we log as much as possible.
            if (error && error.message) {
                console.error('[WS] Error Message:', error.message);
            }
        };
    } catch (e) {
        console.error('[WS] Connection setup failed:', e);
        attemptReconnect(onMessage);
    }
}

/**
 * Attempt reconnection with exponential backoff.
 */
function attemptReconnect(onMessage) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('[WS] Max reconnect attempts reached');
        return;
    }

    const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts);
    reconnectAttempts++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(() => connectWebSocket(onMessage), delay);
}

/**
 * Send heartbeat to keep connection alive.
 */
export function sendHeartbeat() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
    }
}

/**
 * Check if WebSocket is connected.
 */
export function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
}

/**
 * Disconnect WebSocket.
 */
export function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
}

/**
 * Send an arbitrary JSON message via WebSocket.
 * @param {Object} message The message object to send
 */
export function sendMessage(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}
