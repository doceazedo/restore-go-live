export interface CaptureSource {
  id: string;
  name?: string;
  display_id?: string;
}

export function sourceParts(id: string) {
  const [type, handle] = id.split(":");
  return { type, handle };
}

export function sameSource(source: CaptureSource, wanted: string) {
  if (source.id === wanted) return true;

  const want = sourceParts(wanted);
  const have = sourceParts(source.id);
  if (!want.handle || have.type !== want.type) return false;

  return have.handle === want.handle || source.display_id === want.handle;
}

export function electronSourceId(wanted: string) {
  const { type, handle } = sourceParts(wanted);
  if (!type || !handle) return null;
  return wanted.split(":").length > 2 ? wanted : `${type}:${handle}:0`;
}

export function matchSource<T extends CaptureSource>(sources: T[], wanted: string | null) {
  if (!sources.length) return null;
  const picked = wanted ? sources.find(s => sameSource(s, wanted)) : undefined;
  return picked ?? sources.find(s => s.id.startsWith("screen")) ?? sources[0];
}
