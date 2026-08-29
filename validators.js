export function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validateUsername(username) {
  if (username.length < 3 || username.length > 50) {
    return false;
  }
  const usernameRegex = /^[a-zA-Z0-9_-]+$/;
  return usernameRegex.test(username);
}

export function validatePassword(password) {
  if (password.length < 6) {
    return false;
  }
  return true;
}

export function validateDisplayName(displayName) {
  if (!displayName || displayName.trim().length === 0) {
    return false;
  }
  if (displayName.length > 100) {
    return false;
  }
  return true;
}

export function validateBio(bio) {
  if (bio && bio.length > 500) {
    return false;
  }
  return true;
}

export function validateGroupName(name) {
  if (!name || name.trim().length === 0) {
    return false;
  }
  if (name.length > 100) {
    return false;
  }
  return true;
}

export function validateGroupDescription(description) {
  if (description && description.length > 500) {
    return false;
  }
  return true;
}

export function validateMessage(content) {
  if (!content || content.trim().length === 0) {
    return false;
  }
  if (content.length > 5000) {
    return false;
  }
  return true;
}

export function isValidObjectId(id) {
  return /^[a-z0-9]{20,}$/.test(id);
}
