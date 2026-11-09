const PROFILE_FIELDS = [
  'id',
  'username',
  'displayName',
  'avatar',
  'avatarColor',
  'bio',
  'isVerified',
  'isOnline',
  'lastSeen',
  'createdAt',
];

function pickProfileFields(profile) {
  return Object.fromEntries(
    PROFILE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(profile, field))
      .map((field) => [field, profile[field]])
  );
}

/**
 * Serialize a profile for a viewer without returning fields the selected DB
 * record may contain beyond the public profile allow-list.
 */
export function serializeProfileForViewer(profile, {
  isSelf = false,
  showOnlineStatus = true,
} = {}) {
  if (!profile || typeof profile !== 'object') return null;

  const visible = pickProfileFields(profile);
  const isPrivate = Boolean(profile.isPrivate);

  if (isSelf) {
    return {
      ...visible,
      isPrivate,
      profileRestricted: false,
    };
  }

  if (isPrivate) {
    return {
      ...visible,
      bio: null,
      isPrivate: true,
      isOnline: false,
      lastSeen: null,
      profileRestricted: true,
    };
  }

  return {
    ...visible,
    isPrivate: false,
    isOnline: showOnlineStatus ? Boolean(profile.isOnline) : false,
    lastSeen: showOnlineStatus ? profile.lastSeen ?? null : null,
    profileRestricted: false,
  };
}
