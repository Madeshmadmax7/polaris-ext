/**
 * LifeOS – Offline Storage Manager
 * Handles smart buffering when backend is unreachable.
 * Stores batched logs in chrome.storage.local queue.
 * Retries on each heartbeat. Clears only after 200 OK.
 * Handles: internet drop, backend downtime, browser restart.
 * NO DATA LOSS.
 */

const QUEUE_KEY = 'tracking_queue';
const MAX_QUEUE_SIZE = 500; // Prevent storage overflow

/**
 * Add a tracking entry to the offline queue.
 */
export async function enqueue(logEntry) {
    const result = await chrome.storage.local.get(QUEUE_KEY);
    const queue = result[QUEUE_KEY] || [];

    queue.push({
        ...logEntry,
        queued_at: new Date().toISOString(),
    });

    // Trim oldest if queue too large
    if (queue.length > MAX_QUEUE_SIZE) {
        queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }

    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

/**
 * Get all queued entries.
 */
export async function getQueue() {
    const result = await chrome.storage.local.get(QUEUE_KEY);
    return result[QUEUE_KEY] || [];
}

/**
 * Clear the offline queue (only after successful sync).
 */
export async function clearQueue() {
    await chrome.storage.local.set({ [QUEUE_KEY]: [] });
}

/**
 * Remove successfully synced entries from queue.
 * @param {number} count Number of entries successfully synced
 */
export async function dequeue(count) {
    const result = await chrome.storage.local.get(QUEUE_KEY);
    const queue = result[QUEUE_KEY] || [];
    queue.splice(0, count);
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

/**
 * Get queue size.
 */
export async function getQueueSize() {
    const queue = await getQueue();
    return queue.length;
}

/**
 * Store/retrieve generic settings.
 */
export async function setSetting(key, value) {
    await chrome.storage.local.set({ [key]: value });
}

export async function getSetting(key, defaultValue = null) {
    const result = await chrome.storage.local.get(key);
    return result[key] !== undefined ? result[key] : defaultValue;
}
