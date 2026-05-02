export const DEFAULT_BROWSER_PROFILES = Object.freeze({
  chatgpt: './browser-profile',
  gemini: './browser-profile-gemini'
});

const SERVICE_PROFILE_ENV = Object.freeze({
  chatgpt: 'CHATGPT_BROWSER_PROFILE',
  gemini: 'GEMINI_BROWSER_PROFILE'
});

export function resolveBrowserProfile(service, { env = process.env, legacyService = '' } = {}) {
  const aiService = normalizeBrowserProfileService(service);
  const serviceProfile = env[SERVICE_PROFILE_ENV[aiService]];
  if (serviceProfile) return serviceProfile;

  const legacyProfile = env.BROWSER_PROFILE;
  if (legacyProfile && (!legacyService || normalizeBrowserProfileService(legacyService) === aiService)) {
    return legacyProfile;
  }

  return DEFAULT_BROWSER_PROFILES[aiService];
}

export function normalizeBrowserProfileService(value) {
  const service = String(value || 'gemini')
    .trim()
    .toLowerCase();

  if (!Object.hasOwn(DEFAULT_BROWSER_PROFILES, service)) {
    throw new Error('Browser profile service harus "chatgpt" atau "gemini".');
  }

  return service;
}
