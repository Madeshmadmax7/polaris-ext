import { getSetting } from '../utils/storage.js';

const RULE_ID_OFFSET = 1000; // Avoid conflicts with static rules
const RULE_STORAGE_KEY = 'blocking_rules_map';

/**
 * Get the stored rule ID mapping: domain → ruleId
 */
async function getRuleMap() {
    const result = await chrome.storage.local.get(RULE_STORAGE_KEY);
    return result[RULE_STORAGE_KEY] || {};
}

/**
 * Persist rule ID mapping.
 */
async function saveRuleMap(map) {
    await chrome.storage.local.set({ [RULE_STORAGE_KEY]: map });
}

/**
 * Generate a unique rule ID for a domain.
 */
function generateRuleId(domain) {
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
        const char = domain.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return RULE_ID_OFFSET + Math.abs(hash) % 100000;
}

/**
 * Block a domain at the network layer.
 * @param {string} domain Domain to block (e.g., "youtube.com")
 */
export async function blockDomain(domain) {
    const ruleMap = await getRuleMap();

    // Check if already blocked
    if (ruleMap[domain]) {
        console.log(`[Block] Already blocking: ${domain}`);
        return;
    }

    const ruleId = generateRuleId(domain);
    const mode = await getSetting('blocking_mode', 'hard');

    if (mode === 'hard') {
        const rule = {
            id: ruleId,
            priority: 1,
            action: { type: 'block' },
            condition: {
                urlFilter: `||${domain}^`,
                resourceTypes: [
                    'main_frame', 'sub_frame', 'stylesheet', 'script',
                    'image', 'font', 'object', 'xmlhttprequest',
                    'ping', 'media', 'websocket', 'other'
                ],
            },
        };

        try {
            console.log(`[Block] Attempting DNR hard-block for: ${domain} (ID: ${ruleId})`);
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: [rule],
                removeRuleIds: [ruleId],
            });
            console.log(`[Block] DNR success: ${domain}`);
        } catch (error) {
            console.error(`[Block] DNR failed for ${domain}:`, error);
            // Fallthrough to ruleMap update so overlay still works
        }
    } else {
        console.log(`[Block] Soft-mode: keeping DNR clear for ${domain}`);
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId],
        });
    }

    ruleMap[domain] = ruleId;
    await saveRuleMap(ruleMap);
    console.log(`[Block] Persisted ${domain} to blocking_rules_map.`);
}

/**
 * Unblock a domain.
 * @param {string} domain Domain to unblock
 */
export async function unblockDomain(domain) {
    const ruleMap = await getRuleMap();
    const ruleId = ruleMap[domain];

    if (!ruleId) {
        console.log(`[Block] Not blocking: ${domain}`);
        return;
    }

    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId],
        });

        delete ruleMap[domain];
        await saveRuleMap(ruleMap);

        console.log(`[Block] Unblocked: ${domain}`);
    } catch (error) {
        console.error(`[Block] Failed to unblock ${domain}:`, error);
    }
}

/**
 * Sync blocked domains list from backend.
 * Ensures extension rules match backend state.
 * Called on: connect, heartbeat, worker wake.
 * 
 * @param {string[]} domains List of domains that should be blocked
 */
export async function syncBlockedDomains(domains) {
    const ruleMap = await getRuleMap();
    const currentlyBlocked = new Set(Object.keys(ruleMap));
    const shouldBlock = new Set(domains);

    // Add missing blocks
    for (const domain of shouldBlock) {
        if (!currentlyBlocked.has(domain)) {
            await blockDomain(domain);
        }
    }

    // Remove blocks that are no longer active
    for (const domain of currentlyBlocked) {
        if (!shouldBlock.has(domain)) {
            await unblockDomain(domain);
        }
    }

    console.log(`[Block] Synced: ${domains.length} domains blocked`);
}

/**
 * Get all currently blocked domains.
 */
export async function getBlockedDomains() {
    const ruleMap = await getRuleMap();
    return Object.keys(ruleMap);
}

/**
 * Clear all blocking rules (emergency reset).
 */
export async function clearAllRules() {
    const ruleMap = await getRuleMap();
    const ruleIds = Object.values(ruleMap);

    if (ruleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: ruleIds,
        });
    }

    await saveRuleMap({});
    console.log('[Block] All rules cleared');
}
