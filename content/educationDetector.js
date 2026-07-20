/**
 * LifeOS – Education Detector (LCIE)
 * Multi-signal page scoring + rule-based content extraction + learning intent inference.
 * 
 * Runs on all pages EXCEPT:
 * - YouTube (handled by youtubeTracker.js)
 * - Blocked/distracting sites (skip expensive analysis)
 * - Pages with < 200 words
 * - chrome:// and extension pages
 * - Localhost / dashboard
 * 
 * Uses its own storage namespace (lcie_*) — zero interference with existing keys.
 * Sends EDUCATIONAL_CONTENT_DETECTED to background.js for backend processing.
 */

(() => {
    // ═══════════════════════════════════════════════════════════
    //  CONFIGURATION
    // ═══════════════════════════════════════════════════════════

    const DETECTION_THRESHOLD = 0.5;        // Minimum score to consider educational
    const DEBOUNCE_MS = 2000;               // Wait for page to stabilize
    const MIN_WORD_COUNT = 200;             // Skip thin pages
    const MAX_CONTENT_LENGTH = 3000;        // Max chars sent to backend
    const DEDUP_TTL_MS = 30 * 60 * 1000;    // 30 min URL dedup window
    const MAX_HEADINGS = 20;                // Max headings to extract
    const MAX_SNIPPETS = 5;                 // Max context snippets

    // ── Technical vocabulary for content heuristic scoring ──
    const TECHNICAL_TERMS = new Set([
        'algorithm', 'api', 'array', 'async', 'authentication', 'backend',
        'binary', 'boolean', 'cache', 'callback', 'class', 'closure',
        'compiler', 'component', 'concurrency', 'constructor', 'container',
        'database', 'decorator', 'dependency', 'deployment', 'dom',
        'encryption', 'endpoint', 'exception', 'expression', 'framework',
        'function', 'garbage', 'generics', 'git', 'handler', 'hash',
        'heap', 'hook', 'http', 'implementation', 'index', 'inheritance',
        'instance', 'interface', 'iterator', 'json', 'kernel', 'lambda',
        'library', 'linked', 'linux', 'loop', 'memory', 'method',
        'middleware', 'module', 'mutex', 'namespace', 'node', 'object',
        'operator', 'optimization', 'orm', 'package', 'parameter',
        'parser', 'pattern', 'pipeline', 'pointer', 'polymorphism',
        'process', 'promise', 'protocol', 'proxy', 'query', 'queue',
        'recursion', 'refactor', 'regex', 'render', 'repository',
        'request', 'response', 'runtime', 'schema', 'scope', 'sdk',
        'server', 'session', 'socket', 'sorting', 'sql', 'stack',
        'state', 'stream', 'struct', 'syntax', 'template', 'thread',
        'token', 'tree', 'type', 'variable', 'vector', 'virtual',
        'webpack', 'widget', 'yield',
        // Academic
        'theorem', 'proof', 'hypothesis', 'equation', 'derivative',
        'integral', 'matrix', 'vector', 'probability', 'statistics',
        'regression', 'classification', 'neural', 'gradient', 'epoch',
        'normalization', 'optimization', 'convergence', 'loss',
    ]);

    // ── Known programming languages (for code block detection) ──
    const LANGUAGE_MAP = {
        'javascript': 'JavaScript', 'js': 'JavaScript', 'jsx': 'JavaScript',
        'typescript': 'TypeScript', 'ts': 'TypeScript', 'tsx': 'TypeScript',
        'python': 'Python', 'py': 'Python',
        'java': 'Java',
        'cpp': 'C++', 'c++': 'C++', 'cxx': 'C++', 'c': 'C',
        'csharp': 'C#', 'cs': 'C#',
        'go': 'Go', 'golang': 'Go',
        'rust': 'Rust', 'rs': 'Rust',
        'ruby': 'Ruby', 'rb': 'Ruby',
        'php': 'PHP',
        'swift': 'Swift',
        'kotlin': 'Kotlin', 'kt': 'Kotlin',
        'scala': 'Scala',
        'r': 'R',
        'sql': 'SQL', 'mysql': 'SQL', 'postgresql': 'SQL', 'sqlite': 'SQL',
        'html': 'HTML', 'htm': 'HTML',
        'css': 'CSS', 'scss': 'CSS', 'sass': 'CSS', 'less': 'CSS',
        'shell': 'Shell', 'bash': 'Shell', 'sh': 'Shell', 'zsh': 'Shell',
        'yaml': 'YAML', 'yml': 'YAML',
        'json': 'JSON',
        'xml': 'XML',
        'dart': 'Dart',
        'lua': 'Lua',
        'perl': 'Perl',
        'haskell': 'Haskell',
        'elixir': 'Elixir',
        'clojure': 'Clojure',
        'matlab': 'MATLAB',
    };

    // ── Known frameworks/libraries (for technology detection) ──
    const KNOWN_TECHNOLOGIES = [
        'react', 'angular', 'vue', 'svelte', 'next.js', 'nextjs', 'nuxt',
        'express', 'fastapi', 'flask', 'django', 'spring', 'spring boot',
        'node.js', 'nodejs', 'deno', 'bun',
        'docker', 'kubernetes', 'k8s', 'terraform', 'ansible',
        'aws', 'azure', 'gcp', 'google cloud',
        'mongodb', 'postgresql', 'mysql', 'redis', 'elasticsearch',
        'graphql', 'rest api', 'grpc', 'websocket',
        'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy',
        'tailwind', 'bootstrap', 'material ui', 'chakra ui',
        'git', 'github', 'gitlab', 'jenkins', 'ci/cd',
        'jwt', 'oauth', 'openid',
        'webpack', 'vite', 'rollup', 'babel',
        'jest', 'mocha', 'pytest', 'junit',
        'linux', 'nginx', 'apache',
        'flutter', 'react native', 'electron',
        'hibernate', 'sequelize', 'prisma', 'sqlalchemy',
    ];

    // ── URL path keywords that suggest educational content ──
    const EDUCATIONAL_PATH_KEYWORDS = [
        '/docs/', '/doc/', '/documentation/',
        '/tutorial/', '/tutorials/',
        '/learn/', '/learning/',
        '/guide/', '/guides/',
        '/reference/', '/api/',
        '/course/', '/courses/',
        '/lesson/', '/lessons/',
        '/howto/', '/how-to/',
        '/getting-started/',
        '/quickstart/',
        '/handbook/',
        '/manual/',
        '/wiki/',
        '/blog/',
        '/articles/',
        '/questions/',  // StackOverflow
    ];


    // ═══════════════════════════════════════════════════════════
    //  SAFETY CHECKS
    // ═══════════════════════════════════════════════════════════

    function isContextValid() {
        return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    }

    function shouldSkipPage() {
        const hostname = window.location.hostname.toLowerCase();
        const url = window.location.href;

        // Skip non-http pages
        if (!url.startsWith('http')) return true;

        // Skip YouTube (handled by youtubeTracker.js)
        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return true;

        // Skip localhost / dashboard
        if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0') return true;

        // Skip chrome pages
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return true;

        // Skip very short URLs (likely error pages)
        if (url.length < 20) return true;

        return false;
    }


    // ═══════════════════════════════════════════════════════════
    //  A. MULTI-SIGNAL EDUCATIONAL DETECTION
    // ═══════════════════════════════════════════════════════════

    /**
     * Score the current page on educational likelihood (0.0 — 1.0).
     * Uses 5 signals with weighted scoring.
     */
    function computeEducationalScore() {
        let totalScore = 0;
        const hostname = window.location.hostname;

        // ── Signal 1: Domain Registry Match (40% weight) ──
        const registry = window.__LCIE_Registry;
        let domainResult = null;
        if (registry) {
            domainResult = registry.lookupDomain(hostname);
        }
        if (domainResult) {
            totalScore += domainResult.confidence * 0.40;
        }

        // ── Signal 2: URL Path Keywords (15% weight) ──
        const path = window.location.pathname.toLowerCase();
        const pathMatch = EDUCATIONAL_PATH_KEYWORDS.some(kw => path.includes(kw));
        if (pathMatch) {
            totalScore += 0.15;
        }

        // ── Signal 3: Page Metadata (15% weight) ──
        let metaScore = 0;
        try {
            // Check meta keywords
            const metaKeywords = document.querySelector('meta[name="keywords"]');
            if (metaKeywords && metaKeywords.content) {
                const keywords = metaKeywords.content.toLowerCase();
                const techKeywords = [...TECHNICAL_TERMS].filter(t => keywords.includes(t));
                if (techKeywords.length >= 2) metaScore += 0.5;
            }

            // Check og:type
            const ogType = document.querySelector('meta[property="og:type"]');
            if (ogType && ['article', 'website'].includes(ogType.content.toLowerCase())) {
                metaScore += 0.2;
            }

            // Check for structured data (ld+json)
            const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of ldJsonScripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    const schemaType = (data['@type'] || '').toLowerCase();
                    if (['article', 'techarticle', 'howto', 'course', 'learningresource'].includes(schemaType)) {
                        metaScore += 0.5;
                        break;
                    }
                } catch (e) { /* invalid JSON */ }
            }

            // Check meta description for technical terms
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc && metaDesc.content) {
                const desc = metaDesc.content.toLowerCase();
                const matches = [...TECHNICAL_TERMS].filter(t => desc.includes(t));
                if (matches.length >= 2) metaScore += 0.3;
            }
        } catch (e) { /* DOM access error */ }

        totalScore += Math.min(metaScore, 1.0) * 0.15;

        // ── Signal 4: Heading Analysis (15% weight) ──
        let headingScore = 0;
        try {
            const headings = document.querySelectorAll('h1, h2, h3');
            let techHeadings = 0;
            for (const h of headings) {
                const text = (h.textContent || '').toLowerCase();
                const words = text.split(/\s+/);
                for (const word of words) {
                    if (TECHNICAL_TERMS.has(word.replace(/[^a-z]/g, ''))) {
                        techHeadings++;
                        break;
                    }
                }
            }
            if (headings.length > 0) {
                headingScore = Math.min(techHeadings / Math.max(headings.length, 1), 1.0);
            }
        } catch (e) { /* DOM access error */ }

        totalScore += headingScore * 0.15;

        // ── Signal 5: Content Heuristics (15% weight) ──
        let contentScore = 0;
        try {
            // Count code blocks
            const codeBlocks = document.querySelectorAll('pre, code');
            if (codeBlocks.length >= 3) contentScore += 0.4;
            else if (codeBlocks.length >= 1) contentScore += 0.2;

            // Count ordered/unordered lists (common in tutorials)
            const lists = document.querySelectorAll('ol, ul');
            if (lists.length >= 3) contentScore += 0.2;

            // Technical vocabulary density in body text
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const words = bodyText.split(/\s+/);
            if (words.length > 0) {
                let techCount = 0;
                // Sample first 500 words for speed
                const sampleSize = Math.min(words.length, 500);
                for (let i = 0; i < sampleSize; i++) {
                    if (TECHNICAL_TERMS.has(words[i].replace(/[^a-z]/g, ''))) {
                        techCount++;
                    }
                }
                const density = techCount / sampleSize;
                if (density > 0.05) contentScore += 0.4;
                else if (density > 0.02) contentScore += 0.2;
            }
        } catch (e) { /* DOM access error */ }

        totalScore += Math.min(contentScore, 1.0) * 0.15;

        return {
            score: Math.min(totalScore, 1.0),
            domainResult,
        };
    }


    // ═══════════════════════════════════════════════════════════
    //  B. RULE-BASED CONTENT EXTRACTION (No AI needed)
    // ═══════════════════════════════════════════════════════════

    /**
     * Detect programming languages from <code> and <pre> class attributes.
     * e.g., <code class="language-java"> → "Java"
     */
    function detectCodeLanguages() {
        const languages = new Set();
        try {
            const codeElements = document.querySelectorAll('pre[class], code[class]');
            for (const el of codeElements) {
                const classes = el.className.toLowerCase();
                // Match patterns like "language-java", "lang-python", "highlight-js"
                const match = classes.match(/(?:language|lang|highlight)[-_]?(\w+)/);
                if (match) {
                    const lang = LANGUAGE_MAP[match[1]];
                    if (lang) languages.add(lang);
                }
                // Also check data attributes
                const dataLang = el.getAttribute('data-language') || el.getAttribute('data-lang');
                if (dataLang) {
                    const lang = LANGUAGE_MAP[dataLang.toLowerCase()];
                    if (lang) languages.add(lang);
                }
            }
        } catch (e) { /* DOM error */ }
        return [...languages];
    }

    /**
     * Extract heading text for topic identification.
     * Returns array of heading texts, max MAX_HEADINGS.
     */
    function extractHeadings() {
        const headings = [];
        try {
            const elements = document.querySelectorAll('h1, h2, h3');
            for (const el of elements) {
                const text = (el.textContent || '').trim();
                if (text && text.length > 2 && text.length < 200) {
                    headings.push(text);
                }
                if (headings.length >= MAX_HEADINGS) break;
            }
        } catch (e) { /* DOM error */ }
        return headings;
    }

    /**
     * Extract main article text using heuristic:
     * Tries <article>, <main>, then falls back to largest content-dense <div>.
     * Returns first MAX_CONTENT_LENGTH characters.
     */
    function extractMainContent() {
        try {
            // Priority 1: <article> element
            const article = document.querySelector('article');
            if (article && article.textContent.trim().length > MIN_WORD_COUNT) {
                return article.textContent.trim().substring(0, MAX_CONTENT_LENGTH);
            }

            // Priority 2: <main> element
            const main = document.querySelector('main');
            if (main && main.textContent.trim().length > MIN_WORD_COUNT) {
                return main.textContent.trim().substring(0, MAX_CONTENT_LENGTH);
            }

            // Priority 3: role="main"
            const roleMain = document.querySelector('[role="main"]');
            if (roleMain && roleMain.textContent.trim().length > MIN_WORD_COUNT) {
                return roleMain.textContent.trim().substring(0, MAX_CONTENT_LENGTH);
            }

            // Priority 4: Largest content div (heuristic)
            const contentSelectors = [
                '.post-content', '.article-content', '.entry-content',
                '.content', '.post-body', '.article-body',
                '#content', '#main-content', '.markdown-body',
                '.prose', '.documentation-content',
            ];
            for (const sel of contentSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim().length > MIN_WORD_COUNT) {
                    return el.textContent.trim().substring(0, MAX_CONTENT_LENGTH);
                }
            }

            // Fallback: body text (less accurate)
            const bodyText = document.body?.innerText || '';
            if (bodyText.length > MIN_WORD_COUNT) {
                return bodyText.substring(0, MAX_CONTENT_LENGTH);
            }

            return '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Calculate estimated reading time (words ÷ 200 wpm).
     */
    function estimateReadingTime() {
        try {
            const text = document.body?.innerText || '';
            const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
            return Math.max(1, Math.ceil(wordCount / 200));
        } catch (e) {
            return 0;
        }
    }

    /**
     * Detect technologies/frameworks mentioned in page content.
     * Pure rule-based — no AI needed.
     */
    function detectTechnologies() {
        const detected = new Set();
        try {
            const text = (document.body?.innerText || '').toLowerCase();
            const title = (document.title || '').toLowerCase();
            const combined = title + ' ' + text.substring(0, 5000);

            for (const tech of KNOWN_TECHNOLOGIES) {
                // Word boundary matching to avoid partial matches
                // e.g., "react" should not match inside "reactive"
                const regex = new RegExp(`\\b${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                if (regex.test(combined)) {
                    detected.add(tech.charAt(0).toUpperCase() + tech.slice(1));
                }
            }
        } catch (e) { /* DOM error */ }
        return [...detected];
    }

    /**
     * Infer learning intent from URL, title, and content signals.
     * Rule-based heuristics — no AI needed.
     */
    function inferLearningIntent() {
        const url = window.location.href.toLowerCase();
        const path = window.location.pathname.toLowerCase();
        const title = (document.title || '').toLowerCase();
        const hostname = window.location.hostname.toLowerCase();

        // Interview preparation
        if (
            url.includes('interview') || title.includes('interview') ||
            title.includes('questions and answers') || title.includes('faqs') ||
            url.includes('placement') || title.includes('placement')
        ) {
            return 'interview_prep';
        }

        // Debugging
        if (
            url.includes('error') || url.includes('debug') || url.includes('fix') ||
            title.includes('error') || title.includes('how to fix') ||
            title.includes('troubleshoot') || title.includes('debug') ||
            title.includes('solve') || title.includes('issue') ||
            (hostname.includes('stackoverflow.com') && title.includes('error'))
        ) {
            return 'debugging';
        }

        // Documentation / API reference
        if (
            hostname.includes('docs.') || hostname.includes('developer.') ||
            path.includes('/api/') || path.includes('/reference/') ||
            path.includes('/docs/') || path.includes('/documentation/')
        ) {
            return 'documentation';
        }

        // Project development
        if (
            title.includes('build') || title.includes('create') ||
            title.includes('project') || title.includes('implement') ||
            title.includes('deploy') || title.includes('setup')
        ) {
            return 'project_dev';
        }

        // Research
        if (
            hostname.includes('arxiv.org') || hostname.includes('scholar.google') ||
            hostname.includes('researchgate') || hostname.includes('ieee.org') ||
            hostname.includes('acm.org') || title.includes('paper') ||
            title.includes('research') || title.includes('survey')
        ) {
            return 'research';
        }

        // Practice / Assignment
        if (
            hostname.includes('leetcode') || hostname.includes('hackerrank') ||
            hostname.includes('codeforces') || hostname.includes('codechef') ||
            title.includes('practice') || title.includes('exercise') ||
            title.includes('problem set') || title.includes('assignment')
        ) {
            return 'assignment';
        }

        // Revision (URL previously visited — checked via dedup cache)
        // Note: This is checked in the dedup logic below, not here.

        // Default: learning
        return 'learning';
    }

    /**
     * Count visible words on the page.
     */
    function getWordCount() {
        try {
            return (document.body?.innerText || '').split(/\s+/).filter(w => w.length > 0).length;
        } catch (e) {
            return 0;
        }
    }


    // ═══════════════════════════════════════════════════════════
    //  URL DEDUPLICATION
    // ═══════════════════════════════════════════════════════════

    /**
     * Check if this URL was recently analyzed (within DEDUP_TTL_MS).
     * Uses chrome.storage.local with lcie_* namespace.
     */
    async function isDuplicate(url) {
        try {
            const result = await chrome.storage.local.get('lcie_url_cache');
            const cache = result.lcie_url_cache || {};
            const entry = cache[url];
            if (entry && (Date.now() - entry.timestamp) < DEDUP_TTL_MS) {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Mark URL as analyzed in the dedup cache.
     */
    async function markAnalyzed(url) {
        try {
            const result = await chrome.storage.local.get('lcie_url_cache');
            const cache = result.lcie_url_cache || {};

            // Add current URL
            cache[url] = { timestamp: Date.now() };

            // Clean expired entries (keep cache small)
            const now = Date.now();
            for (const key of Object.keys(cache)) {
                if ((now - cache[key].timestamp) > DEDUP_TTL_MS * 2) {
                    delete cache[key];
                }
            }

            await chrome.storage.local.set({ lcie_url_cache: cache });
        } catch (e) {
            // Non-critical
        }
    }

    /**
     * Check if URL was recently visited (for revision intent).
     */
    async function wasRecentlyVisited(url) {
        try {
            const result = await chrome.storage.local.get('lcie_url_cache');
            const cache = result.lcie_url_cache || {};
            const entry = cache[url];
            // If seen before but outside the dedup window (30min-7days)
            if (entry && (Date.now() - entry.timestamp) > DEDUP_TTL_MS) {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }


    // ═══════════════════════════════════════════════════════════
    //  CHECK BLOCKED / DISTRACTING STATUS
    // ═══════════════════════════════════════════════════════════

    /**
     * Check if the current site is blocked or classified as distracting.
     * If so, skip expensive LCIE analysis.
     */
    async function isBlockedOrDistracting() {
        try {
            const storage = await chrome.storage.local.get([
                'site_auto_classification',
                'blocking_rules_map',
            ]);
            const siteClass = storage.site_auto_classification || 'none';
            if (siteClass === 'distracting') return true;

            const ruleMap = storage.blocking_rules_map || {};
            const hostname = window.location.hostname.toLowerCase().replace(/^www\./, '');
            const isBlocked = Object.keys(ruleMap).some(domain => {
                const norm = domain.toLowerCase().replace(/^www\./, '');
                return hostname === norm || hostname.endsWith('.' + norm);
            });
            return isBlocked;
        } catch (e) {
            return false;
        }
    }


    // ═══════════════════════════════════════════════════════════
    //  MAIN: DETECT + EXTRACT + SEND
    // ═══════════════════════════════════════════════════════════

    async function analyzeCurrentPage() {
        if (!isContextValid()) return;
        if (shouldSkipPage()) return;

        // Check if LCIE is enabled
        try {
            const { lcie_enabled } = await chrome.storage.local.get('lcie_enabled');
            if (lcie_enabled === false) return; // Explicitly disabled
        } catch (e) { /* Assume enabled */ }

        // Don't analyze blocked/distracting sites
        if (await isBlockedOrDistracting()) {
            console.log('[LCIE] Skipping blocked/distracting site');
            return;
        }

        // Word count check
        const wordCount = getWordCount();
        if (wordCount < MIN_WORD_COUNT) {
            return; // Too thin to be educational
        }

        // URL dedup check
        const currentUrl = window.location.href.split('#')[0]; // Strip hash fragments
        if (await isDuplicate(currentUrl)) {
            console.log('[LCIE] URL recently analyzed, skipping');
            return;
        }

        // ── SCORE the page ──
        const { score, domainResult } = computeEducationalScore();

        if (score < DETECTION_THRESHOLD) {
            return; // Not educational enough
        }

        console.log(`[LCIE] Educational page detected (score: ${score.toFixed(2)}) — extracting content...`);

        // ── EXTRACT content (rule-based, no AI) ──
        const headings = extractHeadings();
        const content = extractMainContent();
        const languages = detectCodeLanguages();
        const technologies = detectTechnologies();
        const readingTime = estimateReadingTime();
        
        // Check revision intent
        let intent = inferLearningIntent();
        if (intent === 'learning' && await wasRecentlyVisited(currentUrl)) {
            intent = 'revision';
        }

        const pageData = {
            url: currentUrl,
            domain: window.location.hostname.toLowerCase().replace(/^www\./, ''),
            page_title: (document.title || '').trim().substring(0, 500),
            content: content,
            headings: headings,
            detected_languages: languages,
            detected_technologies: technologies,
            learning_intent: intent,
            estimated_reading_minutes: readingTime,
            source_type: domainResult ? domainResult.type : null,
            detection_confidence: score,
        };

        // ── SEND to background (fire-and-forget) ──
        try {
            chrome.runtime.sendMessage({
                type: 'EDUCATIONAL_CONTENT_DETECTED',
                data: pageData,
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('[LCIE] Send failed:', chrome.runtime.lastError.message);
                    return;
                }
                if (response && response.ack) {
                    console.log(`[LCIE] ✓ Content sent to backend (intent: ${intent}, languages: [${languages.join(', ')}], technologies: [${technologies.join(', ')}])`);
                }
            });

            // Mark URL as analyzed
            await markAnalyzed(currentUrl);
        } catch (e) {
            console.debug('[LCIE] Message send failed:', e.message);
        }
    }


    // ═══════════════════════════════════════════════════════════
    //  INITIALIZATION (debounced)
    // ═══════════════════════════════════════════════════════════

    // Wait for page to stabilize before analyzing
    let debounceTimer = null;

    function scheduleAnalysis() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            analyzeCurrentPage().catch(e => {
                console.debug('[LCIE] Analysis error:', e.message);
            });
        }, DEBOUNCE_MS);
    }

    // Initial analysis
    scheduleAnalysis();

    // Re-analyze on significant DOM changes (SPA navigation)
    let lastUrl = window.location.href;
    const urlObserver = new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            console.log('[LCIE] URL changed, re-analyzing...');
            scheduleAnalysis();
        }
    });

    try {
        urlObserver.observe(
            document.querySelector('title') || document.head,
            { childList: true, subtree: true, characterData: true }
        );
    } catch (e) {
        // Fallback: periodic URL check
        setInterval(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                scheduleAnalysis();
            }
        }, 3000);
    }

    // Also listen for History API navigations (pushState/replaceState)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        originalPushState.apply(this, args);
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            scheduleAnalysis();
        }
    };

    history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            scheduleAnalysis();
        }
    };

    window.addEventListener('popstate', () => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            scheduleAnalysis();
        }
    });

    console.log('[LCIE] Education Detector loaded');
})();
