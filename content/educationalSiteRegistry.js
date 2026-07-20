/**
 * LifeOS – Educational Site Registry (LCIE)
 * Configurable registry of known educational domains.
 * 
 * EXTENSIBILITY: To add a new educational website, simply add an entry
 * to EDUCATIONAL_DOMAINS below. No other code changes needed.
 * 
 * Users can also add custom domains via Settings → Knowledge Intelligence,
 * stored in chrome.storage.local under key 'lcie_custom_domains'.
 */

(() => {
    // ═══════════════════════════════════════════════════════════
    //  BUILT-IN EDUCATIONAL DOMAINS (35+ sites)
    // ═══════════════════════════════════════════════════════════

    const EDUCATIONAL_DOMAINS = {
        // ── Documentation ──────────────────────────────────
        'developer.mozilla.org':  { type: 'documentation',     confidence: 0.95 },
        'docs.python.org':        { type: 'documentation',     confidence: 0.95 },
        'docs.oracle.com':        { type: 'documentation',     confidence: 0.90 },
        'docs.microsoft.com':     { type: 'documentation',     confidence: 0.90 },
        'learn.microsoft.com':    { type: 'documentation',     confidence: 0.90 },
        'reactjs.org':            { type: 'documentation',     confidence: 0.95 },
        'react.dev':              { type: 'documentation',     confidence: 0.95 },
        'vuejs.org':              { type: 'documentation',     confidence: 0.95 },
        'angular.io':             { type: 'documentation',     confidence: 0.95 },
        'spring.io':              { type: 'documentation',     confidence: 0.90 },
        'pytorch.org':            { type: 'documentation',     confidence: 0.90 },
        'tensorflow.org':         { type: 'documentation',     confidence: 0.90 },
        'rust-lang.org':          { type: 'documentation',     confidence: 0.95 },
        'go.dev':                 { type: 'documentation',     confidence: 0.95 },
        'kotlinlang.org':         { type: 'documentation',     confidence: 0.95 },
        'nodejs.org':             { type: 'documentation',     confidence: 0.90 },
        'expressjs.com':          { type: 'documentation',     confidence: 0.90 },
        'flask.palletsprojects.com': { type: 'documentation',  confidence: 0.90 },
        'fastapi.tiangolo.com':   { type: 'documentation',     confidence: 0.90 },

        // ── Tutorials & Learning ───────────────────────────
        'w3schools.com':          { type: 'tutorial',          confidence: 0.85 },
        'geeksforgeeks.org':      { type: 'tutorial',          confidence: 0.90 },
        'javatpoint.com':         { type: 'tutorial',          confidence: 0.85 },
        'tutorialspoint.com':     { type: 'tutorial',          confidence: 0.85 },
        'freecodecamp.org':       { type: 'tutorial',          confidence: 0.90 },
        'realpython.com':         { type: 'tutorial',          confidence: 0.90 },
        'baeldung.com':           { type: 'tutorial',          confidence: 0.90 },
        'digitalocean.com':       { type: 'tutorial',          confidence: 0.85 },
        'css-tricks.com':         { type: 'tutorial',          confidence: 0.85 },
        'programiz.com':          { type: 'tutorial',          confidence: 0.85 },

        // ── Blogs & Articles ───────────────────────────────
        'dev.to':                 { type: 'blog',              confidence: 0.75 },
        'medium.com':             { type: 'blog',              confidence: 0.60 },
        'hackernoon.com':         { type: 'blog',              confidence: 0.70 },
        'towardsdatascience.com': { type: 'blog',              confidence: 0.80 },
        'smashingmagazine.com':   { type: 'blog',              confidence: 0.80 },
        'hashnode.dev':           { type: 'blog',              confidence: 0.70 },
        'blog.logrocket.com':     { type: 'blog',              confidence: 0.80 },

        // ── Q&A Forums ─────────────────────────────────────
        'stackoverflow.com':      { type: 'qa_forum',          confidence: 0.90 },
        'superuser.com':          { type: 'qa_forum',          confidence: 0.80 },
        'serverfault.com':        { type: 'qa_forum',          confidence: 0.80 },
        'askubuntu.com':          { type: 'qa_forum',          confidence: 0.80 },
        'stackexchange.com':      { type: 'qa_forum',          confidence: 0.80 },

        // ── Learning Platforms ─────────────────────────────
        'coursera.org':           { type: 'learning_platform', confidence: 0.95 },
        'udemy.com':              { type: 'learning_platform', confidence: 0.90 },
        'edx.org':                { type: 'learning_platform', confidence: 0.95 },
        'nptel.ac.in':            { type: 'learning_platform', confidence: 0.95 },
        'khanacademy.org':        { type: 'learning_platform', confidence: 0.95 },
        'codecademy.com':         { type: 'learning_platform', confidence: 0.90 },
        'pluralsight.com':        { type: 'learning_platform', confidence: 0.90 },
        'skillshare.com':         { type: 'learning_platform', confidence: 0.80 },
        'udacity.com':            { type: 'learning_platform', confidence: 0.90 },
        'datacamp.com':           { type: 'learning_platform', confidence: 0.90 },

        // ── Practice / Competitive ─────────────────────────
        'leetcode.com':           { type: 'practice',          confidence: 0.90 },
        'hackerrank.com':         { type: 'practice',          confidence: 0.90 },
        'codeforces.com':         { type: 'practice',          confidence: 0.90 },
        'codechef.com':           { type: 'practice',          confidence: 0.90 },
        'hackerearth.com':        { type: 'practice',          confidence: 0.85 },
        'kaggle.com':             { type: 'practice',          confidence: 0.85 },
        'replit.com':             { type: 'practice',          confidence: 0.70 },
        'codepen.io':             { type: 'practice',          confidence: 0.70 },
        'codesandbox.io':         { type: 'practice',          confidence: 0.70 },

        // ── Research & Academic ─────────────────────────────
        'arxiv.org':              { type: 'research',          confidence: 0.95 },
        'scholar.google.com':     { type: 'research',          confidence: 0.90 },
        'researchgate.net':       { type: 'research',          confidence: 0.85 },
        'ieee.org':               { type: 'research',          confidence: 0.90 },
        'acm.org':                { type: 'research',          confidence: 0.90 },

        // ── GitHub (documentation/readmes) ──────────────────
        'github.com':             { type: 'documentation',     confidence: 0.70 },
    };


    // ═══════════════════════════════════════════════════════════
    //  PATTERN MATCHES (for subdomains, TLDs)
    // ═══════════════════════════════════════════════════════════

    const EDUCATIONAL_PATTERNS = [
        { pattern: /^docs\..+/i,                type: 'documentation', confidence: 0.85 },
        { pattern: /\.readthedocs\.io$/i,        type: 'documentation', confidence: 0.90 },
        { pattern: /\.github\.io$/i,             type: 'documentation', confidence: 0.70 },
        { pattern: /\.gitbook\.io$/i,            type: 'documentation', confidence: 0.80 },
        { pattern: /\.edu$/i,                    type: 'academic',      confidence: 0.80 },
        { pattern: /\.ac\.[a-z]{2}$/i,           type: 'academic',      confidence: 0.80 },
        { pattern: /wiki\./i,                    type: 'reference',     confidence: 0.70 },
        { pattern: /\.stackexchange\.com$/i,     type: 'qa_forum',      confidence: 0.80 },
        { pattern: /learn\..+/i,                 type: 'tutorial',      confidence: 0.75 },
        { pattern: /tutorial[s]?\..+/i,          type: 'tutorial',      confidence: 0.75 },
    ];


    // ═══════════════════════════════════════════════════════════
    //  LOOKUP FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /**
     * Normalize hostname for comparison.
     * Strips www. prefix and trailing dots.
     */
    function normalizeHost(hostname) {
        return (hostname || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    }

    /**
     * Look up a domain in the educational registry.
     * Checks: custom domains → exact match → parent domain match → patterns.
     * 
     * @param {string} hostname - The page hostname (e.g., "docs.python.org")
     * @returns {{ type: string, confidence: number } | null}
     */
    function lookupDomain(hostname) {
        const host = normalizeHost(hostname);
        if (!host) return null;

        // 1. Check custom user domains (injected at runtime)
        const customEntry = _customDomains[host];
        if (customEntry) return customEntry;

        // 2. Exact match
        if (EDUCATIONAL_DOMAINS[host]) {
            return EDUCATIONAL_DOMAINS[host];
        }

        // 3. Parent domain match (e.g., "en.wikipedia.org" → check "wikipedia.org")
        const parts = host.split('.');
        for (let i = 1; i < parts.length - 1; i++) {
            const parent = parts.slice(i).join('.');
            if (EDUCATIONAL_DOMAINS[parent]) {
                return EDUCATIONAL_DOMAINS[parent];
            }
        }

        // 4. Pattern match
        for (const { pattern, type, confidence } of EDUCATIONAL_PATTERNS) {
            if (pattern.test(host)) {
                return { type, confidence };
            }
        }

        return null;
    }

    /**
     * Quick boolean check — is this domain known educational?
     */
    function isKnownEducational(hostname) {
        return lookupDomain(hostname) !== null;
    }


    // ═══════════════════════════════════════════════════════════
    //  CUSTOM DOMAIN SUPPORT
    // ═══════════════════════════════════════════════════════════

    let _customDomains = {};

    /**
     * Load user-defined custom educational domains from storage.
     */
    async function loadCustomDomains() {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage) return;
            const result = await chrome.storage.local.get('lcie_custom_domains');
            _customDomains = result.lcie_custom_domains || {};
            if (Object.keys(_customDomains).length > 0) {
                console.log(`[LCIE Registry] Loaded ${Object.keys(_customDomains).length} custom domains`);
            }
        } catch (e) {
            // Non-critical
        }
    }

    // Load on script init
    loadCustomDomains();

    // Listen for storage changes to custom domains
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes) => {
                if (changes.lcie_custom_domains) {
                    _customDomains = changes.lcie_custom_domains.newValue || {};
                    console.log(`[LCIE Registry] Custom domains updated: ${Object.keys(_customDomains).length} entries`);
                }
            });
        }
    } catch (e) {
        // Non-critical
    }


    // ═══════════════════════════════════════════════════════════
    //  EXPORT VIA WINDOW (content scripts share window scope)
    // ═══════════════════════════════════════════════════════════

    window.__LCIE_Registry = {
        lookupDomain,
        isKnownEducational,
        normalizeHost,
        EDUCATIONAL_DOMAINS,
        EDUCATIONAL_PATTERNS,
    };

    console.log('[LCIE] Educational Site Registry loaded');
})();
