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

  // Handle domain with sanitization if it's a full URL, or trust it if it's already a domain
  if (data.url) {
    cleaned.domain = sanitizeUrl(data.url) || 'unknown';
  } else if (data.domain) {
    cleaned.domain = data.domain || 'unknown';
  } else {
    cleaned.domain = 'unknown'; // Ensure required field is present to avoid 422
  }

  // Only copy allowed fields that match the backend TrackingLogCreate schema
  const allowedFields = [
    'domain',
    'duration_seconds', 
    'tab_switches', 
    'scroll_depth',
    'is_active', 
    'timestamp', 
    'page_title',
    'yt_classification'
  ];

  for (const field of allowedFields) {
    if (data[field] !== undefined && data[field] !== null) {
      cleaned[field] = data[field];
    }
  }

  // Safety checks for numeric types and non-negativity to avoid 422 validation errors
  cleaned.duration_seconds = Number(cleaned.duration_seconds);
  if (isNaN(cleaned.duration_seconds)) {
    cleaned.duration_seconds = 0;
  }
  cleaned.duration_seconds = Math.max(0, Math.floor(cleaned.duration_seconds));

  cleaned.tab_switches = Number(cleaned.tab_switches);
  if (isNaN(cleaned.tab_switches)) {
    cleaned.tab_switches = 0;
  }
  cleaned.tab_switches = Math.max(0, Math.floor(cleaned.tab_switches));

  cleaned.scroll_depth = Number(cleaned.scroll_depth);
  if (isNaN(cleaned.scroll_depth)) {
    cleaned.scroll_depth = 0;
  }
  cleaned.scroll_depth = Math.min(1.0, Math.max(0.0, cleaned.scroll_depth));

  // Ensure is_active is boolean
  if (cleaned.is_active !== undefined) {
    cleaned.is_active = Boolean(cleaned.is_active);
  } else {
    cleaned.is_active = true;
  }

  // String length truncations matching backend Pydantic field limits
  if (cleaned.domain && cleaned.domain.length > 255) {
    cleaned.domain = cleaned.domain.substring(0, 255);
  }
  if (cleaned.page_title && cleaned.page_title.length > 500) {
    cleaned.page_title = cleaned.page_title.substring(0, 500);
  }
  if (cleaned.yt_classification && cleaned.yt_classification.length > 20) {
    cleaned.yt_classification = cleaned.yt_classification.substring(0, 20);
  }

  return cleaned;
}
