import {
  validateEmail,
  validateUsername,
  validatePassword,
  validateDisplayName
} from './validators.js';

export const validateSignup = (req, res, next) => {
  try {
    const { email, username, displayName, password, confirmPassword } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required',
        code: 'MISSING_EMAIL'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        error: 'Invalid email format',
        code: 'INVALID_EMAIL'
      });
    }

    if (!username) {
      return res.status(400).json({
        error: 'Username is required',
        code: 'MISSING_USERNAME'
      });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({
        error: 'Username must be 3-50 characters and contain only letters, numbers, underscores, or hyphens',
        code: 'INVALID_USERNAME'
      });
    }

    if (displayName && !validateDisplayName(displayName)) {
      return res.status(400).json({
        error: 'Display name must be 1-100 characters',
        code: 'INVALID_DISPLAY_NAME'
      });
    }

    if (!password) {
      return res.status(400).json({
        error: 'Password is required',
        code: 'MISSING_PASSWORD'
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters',
        code: 'WEAK_PASSWORD'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        error: 'Passwords do not match',
        code: 'PASSWORD_MISMATCH'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR'
    });
  }
};

export const validateLogin = (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required',
        code: 'MISSING_EMAIL'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        error: 'Invalid email format',
        code: 'INVALID_EMAIL'
      });
    }

    if (!password) {
      return res.status(400).json({
        error: 'Password is required',
        code: 'MISSING_PASSWORD'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR'
    });
  }
};

export const validateCreateGroup = (req, res, next) => {
  try {
    const { name, description } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        error: 'Group name is required',
        code: 'MISSING_NAME'
      });
    }

    if (name.length > 100) {
      return res.status(400).json({
        error: 'Group name must be less than 100 characters',
        code: 'NAME_TOO_LONG'
      });
    }

    if (description && description.length > 500) {
      return res.status(400).json({
        error: 'Group description must be less than 500 characters',
        code: 'DESCRIPTION_TOO_LONG'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR'
    });
  }
};

export const validateSendMessage = (req, res, next) => {
  try {
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        error: 'Message content is required',
        code: 'EMPTY_CONTENT'
      });
    }

    if (content.length > 5000) {
      return res.status(400).json({
        error: 'Message is too long (max 5000 characters)',
        code: 'CONTENT_TOO_LONG'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR'
    });
  }
};
