export function streamKey(guildId: string | null, channelId: string, ownerId: string) {
  return guildId ? `guild:${guildId}:${channelId}:${ownerId}` : `call:${channelId}:${ownerId}`;
}

export function parseStreamKey(key: string) {
  const parts = key.split(":");
  if (parts[0] === "guild") return { guildId: parts[1], channelId: parts[2], ownerId: parts[3] };
  if (parts[0] === "call") return { guildId: null, channelId: parts[1], ownerId: parts[2] };
  return null;
}
