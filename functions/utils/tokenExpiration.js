export function isExpired(expiresAt, now = new Date()) {
  if (expiresAt === null || expiresAt === undefined) {
    return false;
  }
  const expiresDate = new Date(expiresAt);
  const currentTime = now instanceof Date ? now : new Date(now);
  return currentTime.getTime() > expiresDate.getTime();
}

export function filterAutoDeleteTokens(tokens, now = new Date()) {
  const toDelete = [];
  const toKeep = [];

  for (const token of tokens) {
    if (isExpired(token.expiresAt, now) && token.autoDelete === true) {
      toDelete.push(token);
    } else {
      toKeep.push(token);
    }
  }

  return { toDelete, toKeep };
}
