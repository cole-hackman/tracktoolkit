import crypto from 'crypto';

/**
 * Secure logging utility that sanitizes errors and prevents secret leakage
 */

// Text that may hold a secret, as [pattern, replacement]. A replacement names
// its capture groups and never reuses the match itself: the old replacer kept
// "everything before the first = or :", which for "OAuth X" and "Bearer X"
// (no = or :) was the whole match, credential included.
const SECRET_PATTERNS = [
  // "OAuth X", "Bearer X": the scheme stays, the credential goes.
  [/\b(bearer|oauth)\s+\S+/gi, '$1 ***'],
  // key=X, key: X, key = 'X', "key":"X". The value runs to the next
  // whitespace, so a password holding a comma or a quote goes whole.
  [
    /(client_secret|session_secret|encryption_key|access_token|refresh_token|api_key|authorization|password|secret|token|key)["']?\s*[=:]\s*\S+/gi,
    '$1=***',
  ],
  // ?code=X in a query string: names the list above does not have.
  [/([?&](?:oauth_token|code))=[^&\s"']+/gi, '$1=***'],
];

// Keys that should be redacted from objects
const SECRET_KEYS = [
  'password',
  'secret',
  'token',
  'key',
  'api_key',
  'client_secret',
  'access_token',
  'refresh_token',
  'encryption_key',
  'session_secret',
  'authorization',
  'auth',
  'credentials',
  'private_key',
  'apiKey',
  'accessToken',
  'refreshToken',
];

/**
 * Sanitize a string by removing potential secrets
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  
  let sanitized = str;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Recursively sanitize an object by removing secret keys
 */
function sanitizeObject(obj, depth = 0) {
  // Prevent infinite recursion
  if (depth > 10) return '[Max depth reached]';
  
  if (obj === null || obj === undefined) return obj;
  
  // Handle primitives
  if (typeof obj !== 'object') {
    return sanitizeString(String(obj));
  }
  
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, depth + 1));
  }
  
  // Handle Error objects specially
  if (obj instanceof Error) {
    const sanitized = {
      name: obj.name,
      message: sanitizeString(obj.message),
    };
    
    // Only include stack trace in development
    if (process.env.NODE_ENV === 'development' && obj.stack) {
      sanitized.stack = sanitizeString(obj.stack);
    }
    
    return sanitized;
  }
  
  // Handle regular objects
  const sanitized = {};
  for (const key in obj) {
    if (!obj.hasOwnProperty(key)) continue;
    
    const lowerKey = key.toLowerCase();
    
    // Check if key indicates a secret
    if (SECRET_KEYS.some(secret => lowerKey.includes(secret))) {
      // Special case: client_id is public in OAuth, but be cautious
      if (lowerKey === 'client_id' && typeof obj[key] === 'string') {
        sanitized[key] = obj[key]; // OAuth client_id is public
      } else {
        sanitized[key] = '***';
      }
    } else {
      // Recursively sanitize the value
      sanitized[key] = sanitizeObject(obj[key], depth + 1);
    }
  }
  
  return sanitized;
}

/**
 * Sanitize error information before logging
 */
function sanitizeError(error) {
  if (!error) return error;
  
  // If it's a string, sanitize it
  if (typeof error === 'string') {
    return sanitizeString(error);
  }
  
  // If it's an Error object, create a sanitized version
  if (error instanceof Error) {
    return sanitizeObject(error);
  }
  
  // If it's an object, sanitize it
  if (typeof error === 'object') {
    return sanitizeObject(error);
  }
  
  return error;
}

/**
 * Secure logger that sanitizes all output
 */
export const logger = {
  /**
   * Log an error with sanitization
   */
  error(message, error = null) {
    const sanitizedMessage = sanitizeString(String(message));
    
    if (error) {
      const sanitizedError = sanitizeError(error);
      console.error(`[ERROR] ${sanitizedMessage}`, sanitizedError);
    } else {
      console.error(`[ERROR] ${sanitizedMessage}`);
    }
  },
  
  /**
   * Log a warning with sanitization
   */
  warn(message, data = null) {
    const sanitizedMessage = sanitizeString(String(message));
    
    if (data) {
      const sanitizedData = sanitizeError(data);
      console.warn(`[WARN] ${sanitizedMessage}`, sanitizedData);
    } else {
      console.warn(`[WARN] ${sanitizedMessage}`);
    }
  },
  
  /**
   * Log info (no sanitization needed for info logs, but available)
   */
  info(message, data = null) {
    const sanitizedMessage = sanitizeString(String(message));

    if (data) {
      const sanitizedData = sanitizeError(data);
      console.log(`[INFO] ${sanitizedMessage}`, sanitizedData);
    } else {
      console.log(`[INFO] ${sanitizedMessage}`);
    }
  },
  
  /**
   * Log debug (only in development)
   */
  debug(message, data = null) {
    if (process.env.NODE_ENV === 'development') {
      const sanitizedMessage = sanitizeString(String(message));

      if (data) {
        const sanitizedData = sanitizeError(data);
        console.log(`[DEBUG] ${sanitizedMessage}`, sanitizedData);
      } else {
        console.log(`[DEBUG] ${sanitizedMessage}`);
      }
    }
  },
};

export default logger;

