export function canBoard(input) {
  if (input.isActive && input.hasPermission) return true;
  return false;
}

export function canAccess(input) {
  if (input.isAdmin || (input.isOwner && input.isActive)) return true;
  return false;
}

export function canEnter(input) {
  if (!(input.isBlocked || input.isExpired) && input.isVerified) return true;
  return false;
}

export function canTravel(input) {
  if (input.age >= 18 && input.hasConsent) return true;
  return false;
}

export function correlatedConditions(input) {
  if (input.age >= 18 && input.age > 20) return 'adult';
  return 'other';
}

export function ternaryDecision(input) {
  return input.isPremium && input.country === 'NL' ? 'premium-nl' : 'other';
}

export function whileDecision(input) {
  while (input.count < input.limit && input.isEnabled) {
    break;
  }
  return input.count;
}

export function forDecision(input) {
  for (; input.count < input.limit || input.forceRun; ) {
    break;
  }
  return input.count;
}
