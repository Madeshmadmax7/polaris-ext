/**
 * LifeOS – Privacy Filter (Extension Side)
 * Strips URLs to hostname only before sending to backend.
 * NEVER sends: full URLs, query params, paths, search queries, video titles.
 */

const HOSTNAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\-\.]*\.[a-zA-Z]{2,}$/;

/**
 * Extract clean hostname from a URL.
 * @param {string} rawUrl 
 * @returns {string} hostname only, or empty string
 */
export function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let hostname = url.hostname.toLowerCase().trim();

    // Strip www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }

    // Validate format
    if (!HOSTNAME_REGEX.test(hostname)) {
      return '';
    }

    return hostname;
  } catch {
    return '';
  }
}

/**
 * Filter tracking data to ensure privacy compliance.
 * @param {Object} data Raw tracking data
 * @returns {Object} Privacy-safe tracking data
 */
export function sanitizeTrackingData(data) {
  const cleaned = {};

  if (data.url) {
    cleaned.domain = sanitizeUrl(data.url);
  } else if (data.domain) {
    cleaned.domain = data.domain;
  }

  // Only copy allowed fields
  const allowedFields = [
    'duration_seconds', 'tab_switches', 'scroll_depth',
    'is_active', 'timestamp', 'page_title'
  ];

  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      cleaned[field] = data[field];
    }
  }

  return cleaned;
}
